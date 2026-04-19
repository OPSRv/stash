import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { streamText } from 'ai';

import { useToast } from '../../shared/ui/Toast';

import {
  aiAppendMessage,
  aiCreateSession,
  aiDeleteSession,
  aiListMessages,
  aiListSessions,
  aiRenameSession,
  type Message,
  type Session,
} from './api';
import { ChatComposer } from './ChatComposer';
import { ChatThread } from './ChatThread';
import { EmbeddedWebChat } from './EmbeddedWebChat';
import { buildModel } from './provider';
import { SessionSidebar } from './SessionSidebar';
import { useAiSettings } from './useAiSettings';
import { faviconUrlFor, webchatClose } from './webchatApi';

type Mode = 'api' | '' | string; // '' = tile picker, 'api' or a web service id

const autoTitleFrom = (prompt: string): string => {
  const first = prompt.trim().split('\n')[0] ?? '';
  return first.slice(0, 40) || 'New chat';
};

const modelLabel = (provider: string, model: string): string =>
  `${provider} · ${model || '—'}`;

export const AiShell = () => {
  const settings = useAiSettings();
  const { toast } = useToast();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sidebarExpanded, setSidebarExpanded] = useState(true);

  // API mode only shows up once a model is configured. Hide it otherwise so
  // an empty chat configuration doesn't masquerade as a usable tab.
  const apiAvailable = settings.aiModel.trim().length > 0;

  // Persist the last-active mode so dropping back into the Web tab (even
  // after Unload-Inactive-Tabs or an app restart) lands on the surface the
  // user was using, not the picker. Stored in localStorage keyed simply so
  // we don't need Rust round-trips for what's essentially UI state.
  const LAST_MODE_KEY = 'stash.ai.lastMode';
  const [mode, setMode] = useState<Mode>(() => {
    try {
      const stashed = localStorage.getItem(LAST_MODE_KEY);
      if (stashed === 'api' && apiAvailable) return 'api';
      if (stashed && stashed !== 'api' && stashed !== '') return stashed;
    } catch {
      // localStorage may be unavailable in some contexts
    }
    return apiAvailable ? 'api' : '';
  });

  useEffect(() => {
    try {
      localStorage.setItem(LAST_MODE_KEY, mode);
    } catch {
      // ignore
    }
  }, [mode]);

  // If the API pill vanishes while the user is on it (they cleared the
  // model), fall back to the tile picker.
  useEffect(() => {
    if (!apiAvailable && mode === 'api') setMode('');
  }, [apiAvailable, mode]);

  // External nudge (e.g. clicking the webchat Now Playing bar in the popup
  // shell) that wants us to surface a specific service.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (typeof id === 'string' && id) setMode(id);
    };
    window.addEventListener('stash:ai-open-service', onOpen);
    return () => window.removeEventListener('stash:ai-open-service', onOpen);
  }, []);

  const abortRef = useRef<AbortController | null>(null);

  const activeWebService = useMemo(
    () => settings.aiWebServices.find((s) => s.id === mode),
    [mode, settings.aiWebServices],
  );

  // Close the webview for this service without touching the settings list.
  // Frees the RAM / web process the session was holding. The tab stays in
  // the switcher; clicking it later re-embeds a fresh instance.
  const closeWebService = useCallback(
    async (id: string) => {
      if (mode === id) setMode(''); // fall back to the picker tiles
      await webchatClose(id).catch(() => {});
    },
    [mode],
  );

  useEffect(() => {
    aiListSessions()
      .then((list) => {
        setSessions(list);
        if (list.length > 0) setActiveId(list[0].id);
      })
      .catch((e) => {
        console.error('load sessions failed', e);
      });
  }, []);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    aiListMessages(activeId)
      .then(setMessages)
      .catch((e) => console.error('load messages failed', e));
  }, [activeId]);

  const createNewSession = useCallback(async (): Promise<Session> => {
    const s = await aiCreateSession();
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
    setMessages([]);
    return s;
  }, []);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleSend = useCallback(async () => {
    const prompt = input.trim();
    if (!prompt || isStreaming) return;

    if (!settings.aiModel.trim()) {
      toast({
        title: 'Set a model in Settings → AI',
        description: 'Model name is required before sending.',
        variant: 'error',
      });
      return;
    }

    // Reuse current session or create one the moment the user actually types.
    const session = activeId
      ? sessions.find((s) => s.id === activeId)
      : undefined;
    const sessionId = session?.id ?? (await createNewSession()).id;
    const priorMessages = session ? messages : [];

    const userMsg = await aiAppendMessage({
      sessionId,
      role: 'user',
      content: prompt,
    });
    setMessages((m) => [...m, userMsg]);
    setInput('');

    // First real message: rename session so the sidebar shows a useful label.
    if (priorMessages.length === 0) {
      const title = autoTitleFrom(prompt);
      await aiRenameSession(sessionId, title).catch(() => {});
      setSessions((ss) =>
        ss.map((s) => (s.id === sessionId ? { ...s, title } : s)),
      );
    }

    const key = settings.aiApiKeys[settings.aiProvider];
    if (!key) {
      toast({
        title: 'No API key',
        description: 'Save an API key for this provider in Settings → AI.',
        variant: 'error',
      });
      return;
    }

    let model;
    try {
      model = buildModel(
        {
          provider: settings.aiProvider,
          model: settings.aiModel,
          baseUrl: settings.aiBaseUrl,
        },
        key,
      );
    } catch (e) {
      toast({
        title: 'Model config invalid',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      });
      return;
    }

    const abort = new AbortController();
    abortRef.current = abort;
    setIsStreaming(true);
    setStreamingContent('');

    let acc = '';
    let failed = false;
    try {
      const result = streamText({
        model,
        system: settings.aiSystemPrompt || undefined,
        messages: [...priorMessages, userMsg].map((m) => ({
          role: m.role,
          content: m.content,
        })),
        abortSignal: abort.signal,
      });
      for await (const chunk of result.textStream) {
        acc += chunk;
        setStreamingContent(acc);
      }
    } catch (e) {
      if (!abort.signal.aborted) {
        failed = true;
        toast({
          title: 'Chat failed',
          description: e instanceof Error ? e.message : String(e),
          variant: 'error',
        });
      }
    }

    const stopped = abort.signal.aborted;
    if (acc.length > 0) {
      const persisted = await aiAppendMessage({
        sessionId,
        role: 'assistant',
        content: acc,
        stopped,
      }).catch(() => null);
      if (persisted) setMessages((m) => [...m, persisted]);
    }

    setIsStreaming(false);
    setStreamingContent(null);
    abortRef.current = null;

    if (!failed) {
      // Touch the session so it bubbles to the top of the sidebar.
      setSessions((ss) => {
        const now = Date.now();
        return [...ss]
          .map((s) => (s.id === sessionId ? { ...s, updated_at: now } : s))
          .sort((a, b) => b.updated_at - a.updated_at);
      });
    }
  }, [
    activeId,
    createNewSession,
    input,
    isStreaming,
    messages,
    sessions,
    settings.aiApiKeys,
    settings.aiBaseUrl,
    settings.aiModel,
    settings.aiProvider,
    settings.aiSystemPrompt,
    toast,
  ]);

  // Keyboard: ⌘N new chat, Esc stop streaming (when focused inside the shell).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        createNewSession().catch(() => {});
        return;
      }
      if (e.key === 'Escape' && isStreaming) {
        e.preventDefault();
        handleStop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [createNewSession, handleStop, isStreaming]);

  const handleRename = async (id: string, title: string) => {
    try {
      await aiRenameSession(id, title);
      setSessions((ss) => ss.map((s) => (s.id === id ? { ...s, title } : s)));
    } catch (e) {
      toast({ title: 'Rename failed', description: String(e), variant: 'error' });
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await aiDeleteSession(id);
      setSessions((ss) => ss.filter((s) => s.id !== id));
      if (activeId === id) {
        setActiveId(null);
        setMessages([]);
      }
    } catch (e) {
      toast({ title: 'Delete failed', description: String(e), variant: 'error' });
    }
  };

  // Configuration gate: if toggle is off this tab shouldn't be visible at all
  // (registry filters). If the user lands here without a model/key, show a
  // configuration prompt instead of an empty chat that will silently fail.
  const notConfigured = !settings.aiModel.trim();

  const emptyHero = (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center">
      <div className="t-primary text-title">Ask anything</div>
      <div className="t-tertiary text-meta max-w-[420px]">
        Chat is streamed from {settings.aiProvider}. Your API key stays in the
        macOS Keychain. Press ⌘N for a new chat, Enter to send.
      </div>
    </div>
  );

  const configPrompt = (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
      <div className="t-primary text-title">AI is not configured</div>
      <div className="t-tertiary text-meta max-w-[420px]">
        Open <b>Settings → AI</b> to pick a model, save an API key, and
        (optionally) add a default system prompt.
      </div>
    </div>
  );

  const isApi = mode === 'api';

  return (
    <div className="flex flex-col h-full w-full" style={{ background: 'var(--color-bg)' }}>
      <div className="px-3 py-2 border-b hair flex items-center gap-2">
        <div role="tablist" aria-label="Chat mode" className="flex items-center gap-1 flex-wrap">
          <button
            type="button"
            role="tab"
            aria-selected={mode === ''}
            onClick={() => setMode('')}
            className={`w-7 h-7 rounded-md flex items-center justify-center transition-colors ${
              mode === ''
                ? 't-primary bg-white/[0.08]'
                : 't-secondary hover:bg-white/[0.04]'
            }`}
            title="Show all services"
            aria-label="Show all services"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <rect x="8" y="1.5" width="4.5" height="4.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <rect x="1.5" y="8" width="4.5" height="4.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <rect x="8" y="8" width="4.5" height="4.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
          {apiAvailable && (
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'api'}
              onClick={() => setMode('api')}
              className={`px-2.5 py-1 rounded-md text-meta transition-colors ${
                mode === 'api'
                  ? 't-primary bg-white/[0.08]'
                  : 't-secondary hover:bg-white/[0.04]'
              }`}
            >
              API
            </button>
          )}
          {settings.aiWebServices.map((s) => {
            const active = mode === s.id;
            const favicon = faviconUrlFor(s.url, 16);
            return (
              <div
                key={s.id}
                className={`group flex items-center rounded-md transition-colors ${
                  active ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]'
                }`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setMode(s.id)}
                  className={`flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-md text-meta ${
                    active ? 't-primary' : 't-secondary'
                  }`}
                >
                  {favicon && (
                    <img
                      src={favicon}
                      alt=""
                      width={14}
                      height={14}
                      className="rounded-sm"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                      }}
                    />
                  )}
                  <span>{s.label}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Close ${s.label}`}
                  title={`Close ${s.label} (free RAM; reopens on click)`}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeWebService(s.id).catch(() => {});
                  }}
                  className="opacity-0 group-hover:opacity-100 focus:opacity-100 t-tertiary hover:text-red-400 px-1 py-0.5 rounded-md text-meta transition-opacity"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex-1" />
        {isApi && (
          <span
            className="px-2 py-0.5 rounded-full text-meta truncate"
            style={{ background: 'rgba(var(--stash-accent-rgb), 0.18)' }}
            title={modelLabel(settings.aiProvider, settings.aiModel)}
          >
            {modelLabel(settings.aiProvider, settings.aiModel)}
          </span>
        )}
        {isApi && isStreaming && (
          <span className="t-tertiary text-meta shrink-0" aria-live="polite">
            streaming…
          </span>
        )}
      </div>
      {isApi ? (
        <div className="flex flex-1 min-h-0 w-full">
          <SessionSidebar
            sessions={sessions}
            activeId={activeId}
            expanded={sidebarExpanded}
            onSelect={setActiveId}
            onCreate={() => {
              createNewSession().catch(() => {});
            }}
            onRename={handleRename}
            onDelete={handleDelete}
          />
          <section className="flex-1 flex flex-col min-w-0">
            <div className="flex items-center gap-2 px-3 py-1.5 border-b hair">
              <button
                type="button"
                onClick={() => setSidebarExpanded((v) => !v)}
                aria-label={sidebarExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
                title={sidebarExpanded ? 'Collapse' : 'Expand'}
                className="ring-focus w-6 h-6 rounded-md flex items-center justify-center t-secondary hover:t-primary hover:bg-white/[0.06] transition-colors shrink-0"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <path
                    d={sidebarExpanded ? 'M9 3 L5 7 L9 11' : 'M5 3 L9 7 L5 11'}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
            {notConfigured ? (
              configPrompt
            ) : (
              <ChatThread
                messages={messages}
                streamingContent={streamingContent}
                emptyHero={emptyHero}
              />
            )}
            <ChatComposer
              value={input}
              onChange={setInput}
              onSend={() => {
                handleSend().catch(() => {});
              }}
              onStop={handleStop}
              isStreaming={isStreaming}
              disabled={notConfigured}
              placeholder={
                notConfigured ? 'Configure AI in Settings first.' : undefined
              }
            />
          </section>
        </div>
      ) : activeWebService ? (
        <EmbeddedWebChat key={activeWebService.id} service={activeWebService} />
      ) : (
        <div className="flex-1 overflow-y-auto nice-scroll p-6">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 max-w-[720px] mx-auto">
            {settings.aiWebServices.length === 0 && (
              <div className="col-span-full t-tertiary text-meta text-center py-8">
                No web services configured. Add one in Settings → Web.
              </div>
            )}
            {settings.aiWebServices.map((s) => {
              const favicon = faviconUrlFor(s.url, 64);
              let host = s.url;
              try {
                host = new URL(s.url).hostname;
              } catch {
                // keep raw URL on parse failure
              }
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setMode(s.id)}
                  className="group flex flex-col items-center gap-2 p-4 rounded-xl border hair hover:bg-white/[0.04] transition-colors text-center"
                  style={{ background: 'var(--color-surface)' }}
                >
                  {favicon ? (
                    <img
                      src={favicon}
                      alt=""
                      width={40}
                      height={40}
                      className="rounded-md"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                      }}
                    />
                  ) : (
                    <div
                      className="w-10 h-10 rounded-md flex items-center justify-center t-primary font-semibold"
                      style={{ background: 'rgba(var(--stash-accent-rgb), 0.18)' }}
                    >
                      {s.label.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div className="t-primary text-body font-medium">{s.label}</div>
                  <div className="t-tertiary text-meta truncate max-w-full">{host}</div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
