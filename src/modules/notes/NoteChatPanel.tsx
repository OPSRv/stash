import { useCallback, useEffect, useRef, useState } from 'react';

import { IconButton } from '../../shared/ui/IconButton';
import { Button } from '../../shared/ui/Button';
import { CloseIcon, ExternalIcon, NoteIcon } from '../../shared/ui/icons';
import { useToast } from '../../shared/ui/Toast';
import {
  aiCreateSession,
  aiFindSessionByContext,
  type Session,
} from '../ai/api';
import { ChatComposer } from '../ai/ChatComposer';
import { ChatThread } from '../ai/ChatThread';
import { useAiChat } from '../ai/useAiChat';
import { useAiSettings } from '../ai/useAiSettings';

type Props = {
  /** Id of the note the chat is anchored to. One chat per note; the backing
   *  session is created lazily on the first message. */
  noteId: number;
  /** Current note title/body so new chats start with useful context in
   *  their title and empty-state prompt. */
  noteTitle: string;
  noteBody: string;
  onClose: () => void;
};

/** Right-docked AI chat for the active note. Resolves or lazily creates an
 *  `ai_sessions` row tagged `kind='note', context_ref=<noteId>` so the chat
 *  shows up in the shared sessions sidebar of the main AI tab alongside
 *  regular chats — users can pick it up there and continue on a bigger
 *  surface if they like. */
export const NoteChatPanel = ({ noteId, noteTitle, noteBody, onClose }: Props) => {
  const settings = useAiSettings();
  const { toast } = useToast();

  const [session, setSession] = useState<Session | null>(null);
  const [input, setInput] = useState('');
  /** Guards against double-creating the per-note session when the user
   *  taps Send twice in quick succession while `ensureSession` is in
   *  flight. */
  const creatingRef = useRef<Promise<Session | null> | null>(null);

  // Resolve the existing bound session when the note changes. Creation is
  // deferred to `ensureSession` below so opening the panel on every note
  // doesn't spam empty sessions into the sidebar.
  useEffect(() => {
    let cancelled = false;
    setSession(null);
    setInput('');
    aiFindSessionByContext('note', String(noteId))
      .then((s) => {
        if (!cancelled) setSession(s);
      })
      .catch(() => {
        /* no chat yet — stays null, created on first send */
      });
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  const ensureSession = useCallback(async (): Promise<Session | null> => {
    if (session) return session;
    if (creatingRef.current) return creatingRef.current;
    const titled = noteTitle.trim() || 'Untitled note';
    const title = `Note · ${titled.slice(0, 40)}`;
    const p = aiCreateSession(title, 'note', String(noteId))
      .then((s) => {
        setSession(s);
        return s;
      })
      .catch((e) => {
        console.error('[NoteChatPanel] create session failed', e);
        toast({ title: 'Chat init failed', description: String(e), variant: 'error' });
        return null;
      })
      .finally(() => {
        creatingRef.current = null;
      });
    creatingRef.current = p;
    return p;
  }, [noteId, noteTitle, session, toast]);

  const onSessionTitled = useCallback(
    (_id: string, title: string) => {
      setSession((prev) => (prev ? { ...prev, title } : prev));
    },
    []
  );

  const chat = useAiChat({
    sessionId: session?.id ?? null,
    settings,
    ensureSession,
    onSessionTitled,
    onError: (err) => {
      if (err.kind === 'no-model') {
        toast({
          title: 'Set a model in Settings → AI',
          description: 'Model name is required before sending.',
          variant: 'error',
        });
      } else if (err.kind === 'no-api-key') {
        toast({
          title: 'No API key',
          description: 'Save an API key for this provider in Settings → AI.',
          variant: 'error',
        });
      } else {
        toast({ title: 'Chat failed', description: err.message, variant: 'error' });
      }
    },
  });

  const send = useCallback(async () => {
    const value = input.trim();
    if (!value) return;
    setInput('');
    await chat.send(value);
  }, [chat, input]);

  /** Jump to this session in the main AI tab. Uses the same service-open
   *  event bus the clipboard tab uses, so the AI shell can route there
   *  without importing notes. */
  const openInAiTab = useCallback(() => {
    if (!session) return;
    window.dispatchEvent(
      new CustomEvent('stash:ai-open-session', { detail: session.id })
    );
    window.dispatchEvent(new CustomEvent('stash:navigate', { detail: 'ai' }));
  }, [session]);

  const emptyHero = (
    <div className="flex flex-col items-center justify-center flex-1 gap-2 t-tertiary px-6 text-center">
      <NoteIcon size={28} />
      <div className="text-body t-secondary">Ask AI about this note</div>
      <div className="text-meta">
        Your note&rsquo;s text goes with each message as context.
        {!noteBody.trim() && ' Write something first to get a useful answer.'}
      </div>
    </div>
  );

  const aiReady =
    Boolean(settings.aiModel.trim()) &&
    Boolean(settings.aiApiKeys[settings.aiProvider]);

  return (
    <aside
      className="shrink-0 border-l hair flex flex-col min-w-0 overflow-hidden"
      style={{ width: 360 }}
      data-testid="notes-chat-panel"
      aria-label="AI chat for this note"
    >
      <header className="px-3 py-2 flex items-center gap-2 border-b hair">
        <span className="t-primary text-meta font-medium truncate flex-1">
          {session?.title || 'AI chat'}
        </span>
        {session && (
          <IconButton
            onClick={openInAiTab}
            title="Open in AI tab"
            stopPropagation={false}
          >
            <ExternalIcon size={12} />
          </IconButton>
        )}
        <IconButton onClick={onClose} title="Close chat" stopPropagation={false}>
          <CloseIcon size={13} />
        </IconButton>
      </header>
      {!aiReady ? (
        <div className="flex-1 flex flex-col items-center justify-center px-5 py-6 gap-3 text-center">
          <div className="t-primary text-body">AI not configured</div>
          <div className="t-tertiary text-meta">
            Add an API key and a model in Settings &rarr; AI to start chatting about
            your notes.
          </div>
          <Button
            size="sm"
            variant="soft"
            tone="accent"
            onClick={() =>
              window.dispatchEvent(new CustomEvent('stash:navigate', { detail: 'settings' }))
            }
          >
            Open Settings
          </Button>
        </div>
      ) : (
        <>
          <ChatThread
            messages={chat.messages}
            streamingContent={chat.streamingContent}
            emptyHero={emptyHero}
          />
          <ChatComposer
            value={input}
            onChange={setInput}
            onSend={send}
            onStop={chat.stop}
            isStreaming={chat.isStreaming}
            placeholder="Ask about this note…"
          />
        </>
      )}
    </aside>
  );
};
