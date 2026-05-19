import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

import { Button } from '../shared/ui/Button';
import { ContextMenu, type ContextMenuItem } from '../shared/ui/ContextMenu';
import { IconButton } from '../shared/ui/IconButton';
import { Input } from '../shared/ui/Input';
import { Modal } from '../shared/ui/Modal';
import { PinIcon } from '../shared/ui/icons';
import { Markdown } from '../shared/ui/Markdown';
import { Spinner } from '../shared/ui/Spinner';
import { Textarea } from '../shared/ui/Textarea';
import { useToast } from '../shared/ui/Toast';
import { accent } from '../shared/theme/accent';
import { copyText } from '../shared/util/clipboard';
import { revealFile } from '../shared/util/revealFile';
import { normaliseFileSrc } from '../shared/ui/FilePreview';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import * as api from './api';
import type { QuickCommand, VoiceCommand } from './api';
import { useRecorder } from './useRecorder';

type Status = 'idle' | 'recording' | 'transcribing' | 'thinking';

type Turn = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  documents?: string[];
};

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|heif|tiff?)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv)$/i;
const AUDIO_EXT = /\.(mp3|m4a|wav|flac|ogg|opus|aac)$/i;

const basename = (p: string): string => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
};

const LINE_HEIGHT = 20;
const MIN_ROWS = 1;
const MAX_ROWS = 6;
const V_PADDING = 16;

const makeId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/// Voice + chat capsule. The window is conjured by `⌘⇧A` from the
/// menubar app and stays hidden between invocations. The popup is the
/// same surface as the Telegram bot — slash commands go through
/// `state.find_command(...)` on the Rust side, free text goes through
/// the shared assistant pipeline, so history, tools, and `/timer`-style
/// deterministic actions are all reachable from here.
export const VoicePopup = () => {
  const { toast } = useToast();
  const [status, setStatus] = useState<Status>('idle');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [silenceMs, setSilenceMs] = useState<number | null>(null);
  const [commands, setCommands] = useState<VoiceCommand[]>([]);
  const [pinned, setPinned] = useState(false);
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>([]);
  const [editingQuick, setEditingQuick] = useState<QuickCommand | 'new' | null>(
    null,
  );
  const [pendingAttachments, setPendingAttachments] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const askInFlightRef = useRef(false);
  const threadRef = useRef<HTMLDivElement | null>(null);

  // Pull autostop preference + command catalog whenever the popup is
  // raised — flipping a setting or registering a new command in the
  // main app shouldn't require relaunch.
  const refresh = useCallback(async () => {
    try {
      const s = await api.getVoiceSettings();
      setSilenceMs(s.autostop_enabled ? s.autostop_silence_ms : null);
    } catch {
      setSilenceMs(null);
    }
    try {
      const list = await api.listCommands();
      setCommands(list);
    } catch {
      /* commands list is best-effort; autocomplete just stays empty */
    }
    try {
      setPinned(await api.getPopupPinned());
    } catch {
      /* keep current state */
    }
    try {
      setQuickCommands(await api.getQuickCommands());
    } catch {
      /* fall back to whatever is in memory */
    }
  }, []);

  const persistQuick = useCallback(
    async (next: QuickCommand[]) => {
      setQuickCommands(next);
      try {
        await api.setQuickCommands(next);
      } catch (e) {
        toast({
          title: 'Не вдалося зберегти',
          description: e instanceof Error ? e.message : String(e),
          variant: 'error',
        });
      }
    },
    [toast],
  );

  const togglePinned = useCallback(() => {
    const next = !pinned;
    setPinned(next);
    void api.setPopupPinned(next).catch(() => setPinned(!next));
  }, [pinned]);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    // Backend emits `voice-popup:shown` on every `voice_popup_show`.
    // Plain focus events miss the case where the window was already
    // focused from a prior session, so the command catalog stays stale
    // and most slash-commands never appear in autocomplete.
    const unlisten = listen('voice-popup:shown', () => void refresh());
    return () => {
      window.removeEventListener('focus', onFocus);
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [refresh]);

  // Clipboard paste — grab image blobs and persist them through the
  // Rust side so we get a stable filesystem path. Text paste is
  // handled by the browser natively, so we only intercept when an
  // image item is present.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const images: { blob: Blob; ext: string }[] = [];
      for (const item of items) {
        if (item.kind !== 'file') continue;
        const blob = item.getAsFile();
        if (!blob) continue;
        if (!blob.type.startsWith('image/')) continue;
        const ext = blob.type.split('/').pop()?.split(';')[0] ?? 'png';
        images.push({ blob, ext });
      }
      if (images.length === 0) return;
      e.preventDefault();
      void Promise.all(
        images.map(async ({ blob, ext }) => {
          const buf = new Uint8Array(await blob.arrayBuffer());
          return api.saveAttachment(buf, ext);
        }),
      )
        .then((paths) => {
          setPendingAttachments((prev) => [...prev, ...paths]);
        })
        .catch((err) => {
          toast({
            title: 'Paste failed',
            description: err instanceof Error ? err.message : String(err),
            variant: 'error',
          });
        });
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [toast]);

  // OS-level drag-drop. HTML5 drop events don't carry absolute paths
  // in Tauri's hardened webview; `onDragDropEvent` is the only way to
  // get real filesystem paths back to JS.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === 'enter' || p.type === 'over') {
          setDragOver(true);
        } else if (p.type === 'leave') {
          setDragOver(false);
        } else if (p.type === 'drop') {
          setDragOver(false);
          if (p.paths.length > 0) {
            setPendingAttachments((prev) => [...prev, ...p.paths]);
          }
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* not in Tauri (tests, vite preview) — drop is a no-op */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const recorder = useRecorder({ silenceMs });

  // Auto-scroll the thread to the newest turn whenever it grows or the
  // streaming placeholder swaps for a final reply.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns, status]);

  const submitPrompt = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (askInFlightRef.current) return;
      if (!trimmed && pendingAttachments.length === 0) return;
      askInFlightRef.current = true;
      const userTurn: Turn = {
        id: makeId(),
        role: 'user',
        content: trimmed,
        documents: pendingAttachments.length > 0 ? pendingAttachments : undefined,
      };
      const attachmentsSnapshot = pendingAttachments;
      setTurns((t) => [...t, userTurn]);
      setPendingAttachments([]);
      setStatus('thinking');
      try {
        const reply = await api.ask(trimmed, attachmentsSnapshot);
        setTurns((t) => [
          ...t,
          {
            id: makeId(),
            role: 'assistant',
            content: reply.text.trim(),
            documents: reply.documents,
          },
        ]);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const lower = msg.toLowerCase();
        const isMissingKey =
          lower.includes('api key') ||
          lower.includes('api_key') ||
          lower.includes('not configured') ||
          lower.includes('missing key');
        if (isMissingKey) {
          toast({
            title: 'AI не налаштовано',
            description:
              'Відкрий Settings → AI і додай API key для активного провайдера. Слеш-команди (наприклад /screenshot, /note) працюють без LLM.',
            variant: 'error',
          });
          // Drop the user turn that produced the error — the next
          // attempt should start from a clean thread state. Bringing
          // up Settings is left to the user so we don't yank focus
          // away from the popup unexpectedly.
        } else {
          toast({
            title: 'Помилка асистента',
            description: msg,
            variant: 'error',
          });
        }
      } finally {
        setStatus('idle');
        askInFlightRef.current = false;
      }
    },
    [pendingAttachments, toast],
  );

  const runVoiceTurn = useCallback(async () => {
    if (askInFlightRef.current) return;
    askInFlightRef.current = true;
    try {
      setStatus('recording');
      const rec = await recorder.start();
      setStatus('transcribing');
      const text = (await api.transcribe(rec.bytes, rec.extension)).trim();
      if (!text) {
        toast({ title: 'Нічого не почув', variant: 'error' });
        setStatus('idle');
        return;
      }
      askInFlightRef.current = false;
      await submitPrompt(text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== 'cancelled') {
        toast({
          title: 'Помилка асистента',
          description: msg,
          variant: 'error',
        });
      }
      setStatus('idle');
    } finally {
      askInFlightRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitPrompt]);

  const onMicClick = () => {
    if (status === 'recording') {
      recorder.stop();
    } else if (status === 'idle') {
      void runVoiceTurn();
    }
  };

  const onSend = () => {
    if (status !== 'idle') return;
    const text = input;
    setInput('');
    void submitPrompt(text);
  };

  const clearThread = () => {
    setTurns([]);
    setInput('');
    setPendingAttachments([]);
  };

  // Click on a quick-command pill. Two flavours: prompts ending with
  // a space (e.g. `/note `) get loaded into the textarea so the user
  // can finish them; anything else fires immediately through the same
  // `voice_ask` pipeline as a typed slash-command.
  const runQuickCommand = useCallback(
    (cmd: QuickCommand) => {
      if (status !== 'idle') return;
      const needsArgs = /\s$/.test(cmd.prompt);
      if (needsArgs) {
        setInput(cmd.prompt);
        return;
      }
      void submitPrompt(cmd.prompt);
    },
    [status, submitPrompt],
  );

  const dismiss = useCallback(() => {
    if (recorder.phase !== 'idle') recorder.cancel();
    void api.hidePopup();
  }, [recorder]);

  // Esc dismisses the popup — covers click-outside too because the
  // backend hides on blur.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismiss();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismiss]);

  return (
    <div
      role="dialog"
      aria-label="Voice assistant"
      className="relative h-screen w-screen flex flex-col pane rounded-2xl overflow-hidden"
      style={{
        // Force a solid-ish background — the global `--stash-pane-opacity-dark`
        // can be dialled down by the user, which made the popup unreadable
        // against busy wallpapers. Voice popup overrides the token locally
        // so it always stays at least 85 % opaque.
        ['--stash-pane-opacity-dark' as never]: 0.92,
        ['--stash-pane-opacity-light' as never]: 0.95,
      }}
    >
      <Header
        onClear={clearThread}
        onClose={dismiss}
        onTogglePin={togglePinned}
        pinned={pinned}
        hasTurns={turns.length > 0}
      />
      <QuickCommandTray
        commands={quickCommands}
        onRun={runQuickCommand}
        onEdit={(cmd) => setEditingQuick(cmd)}
        onDelete={(cmd) =>
          void persistQuick(quickCommands.filter((c) => c.id !== cmd.id))
        }
        onAdd={() => setEditingQuick('new')}
      />
      <Thread ref={threadRef} turns={turns} status={status} />
      {pendingAttachments.length > 0 && (
        <PendingAttachmentStrip
          paths={pendingAttachments}
          onRemove={(p) =>
            setPendingAttachments((prev) => prev.filter((x) => x !== p))
          }
        />
      )}
      <Composer
        value={input}
        onChange={setInput}
        onSend={onSend}
        onMic={onMicClick}
        status={status}
        recorderLevel={recorder.level}
        commands={commands}
      />
      {dragOver && (
        <div
          className="absolute inset-0 pointer-events-none flex items-center justify-center rounded-2xl"
          style={{
            background: accent(0.15),
            border: `2px dashed ${accent(0.6)}`,
          }}
        >
          <div
            className="px-4 py-2 rounded-lg pane t-primary text-body"
            style={{ color: 'rgb(var(--stash-accent-rgb))' }}
          >
            Drop files to attach
          </div>
        </div>
      )}
      {editingQuick !== null && (
        <QuickCommandEditor
          initial={editingQuick === 'new' ? null : editingQuick}
          onCancel={() => setEditingQuick(null)}
          onSave={(cmd) => {
            const exists = quickCommands.some((c) => c.id === cmd.id);
            const next = exists
              ? quickCommands.map((c) => (c.id === cmd.id ? cmd : c))
              : [...quickCommands, cmd];
            void persistQuick(next);
            setEditingQuick(null);
          }}
        />
      )}
    </div>
  );
};

// ---------------------------- Header ----------------------------

const Header = ({
  onClear,
  onClose,
  onTogglePin,
  pinned,
  hasTurns,
}: {
  onClear: () => void;
  onClose: () => void;
  onTogglePin: () => void;
  pinned: boolean;
  hasTurns: boolean;
}) => (
  <div
    data-tauri-drag-region
    className="flex items-center gap-2 px-3 py-2 border-b hair shrink-0 cursor-grab active:cursor-grabbing"
  >
    <div
      data-tauri-drag-region
      className="t-secondary text-meta font-medium tracking-wide uppercase pointer-events-none"
    >
      Stash Voice
    </div>
    <div
      data-tauri-drag-region
      className="t-tertiary text-meta tabular-nums pointer-events-none"
    >
      ⌘⇧A · Esc
    </div>
    <div data-tauri-drag-region className="flex-1" />
    <IconButton
      title={pinned ? 'Unpin window' : 'Pin window on top'}
      onClick={onTogglePin}
      active={pinned}
      tooltipSide="bottom"
    >
      <PinIcon size={14} filled={pinned} />
    </IconButton>
    {hasTurns && (
      <IconButton
        title="Clear conversation"
        onClick={onClear}
        tooltipSide="bottom"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path
            d="M3 4h8M5 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M4.5 4l.5 7a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1l.5-7"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </IconButton>
    )}
    <IconButton title="Dismiss (Esc)" onClick={onClose} tooltipSide="bottom">
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <path
          d="M3 3l8 8M11 3l-8 8"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    </IconButton>
  </div>
);

// ---------------------------- Thread ----------------------------

type ThreadProps = {
  turns: Turn[];
  status: Status;
};

const Thread = forwardRef<HTMLDivElement, ThreadProps>(
  ({ turns, status }, ref) => {
    const empty = turns.length === 0 && status === 'idle';
    return (
      <div
        ref={ref}
        className="flex-1 min-h-0 overflow-y-auto nice-scroll px-3 py-3 flex flex-col gap-2"
      >
        {empty ? (
          <EmptyHero />
        ) : (
          <>
            {turns.map((t) => (
              <Bubble
                key={t.id}
                role={t.role}
                content={t.content}
                documents={t.documents}
              />
            ))}
            {status === 'transcribing' && (
              <InlineStatus icon={<Spinner size={12} />} label="Транскрибую…" />
            )}
            {status === 'thinking' && (
              <InlineStatus icon={<Spinner size={12} />} label="Думаю…" />
            )}
          </>
        )}
      </div>
    );
  },
);
Thread.displayName = 'VoiceThread';

const EmptyHero = () => (
  <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-6">
    <div className="t-primary text-title">Ask Stash anything</div>
    <div className="t-tertiary text-meta max-w-[400px]">
      Натисни мікрофон щоб говорити, або введи запит. Слеш-команди (
      <code>/help</code>, <code>/timer 25</code>, <code>/note</code>…) працюють
      як у Telegram-боті.
    </div>
  </div>
);

const InlineStatus = ({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}) => (
  <div className="self-start flex items-center gap-2 t-secondary text-meta px-3 py-1.5 pane rounded-lg">
    {icon}
    <span>{label}</span>
  </div>
);

const Bubble = ({
  role,
  content,
  documents,
}: {
  role: 'user' | 'assistant';
  content: string;
  documents?: string[];
}) => {
  if (role === 'user') {
    return (
      <div
        className="self-end max-w-[88%] rounded-2xl px-3.5 py-2 text-body whitespace-pre-wrap shadow-sm"
        style={{
          background: accent(0.18),
          color: 'rgb(var(--stash-accent-rgb))',
        }}
      >
        {content}
      </div>
    );
  }
  const docs = documents ?? [];
  return (
    <div className="self-start max-w-[92%] rounded-2xl px-3.5 py-2 text-body pane-elev shadow-sm flex flex-col gap-2">
      {content ? <Markdown source={content} className="t-primary" /> : null}
      {docs.length > 0 && <AttachmentGrid paths={docs} />}
    </div>
  );
};

// ---------------------------- Attachments ----------------------------

const AttachmentGrid = ({ paths }: { paths: string[] }) => {
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(
    null,
  );
  const { toast } = useToast();

  const openContextMenu = (e: React.MouseEvent, path: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, path });
  };

  const items: ContextMenuItem[] = useMemo(() => {
    if (!menu) return [];
    const path = menu.path;
    return [
      {
        kind: 'action',
        label: 'Open',
        onSelect: () => {
          import('@tauri-apps/plugin-opener')
            .then((m) => m.openPath(path))
            .catch((err) => {
              toast({
                title: 'Could not open',
                description: err instanceof Error ? err.message : String(err),
                variant: 'error',
              });
            });
        },
      },
      {
        kind: 'action',
        label: 'Reveal in Finder',
        shortcut: '⌥⌘R',
        onSelect: () => {
          void revealFile(path);
        },
      },
      { kind: 'separator' },
      {
        kind: 'action',
        label: 'Copy path',
        shortcut: '⌘C',
        onSelect: () => {
          void copyText(path).then((ok) => {
            if (ok) toast({ title: 'Path copied', variant: 'success' });
          });
        },
      },
      {
        kind: 'action',
        label: 'Copy filename',
        onSelect: () => {
          void copyText(basename(path));
        },
      },
      {
        kind: 'action',
        label: 'Ask AI about this file',
        onSelect: () => {
          window.dispatchEvent(
            new CustomEvent('stash:ai-prefill', {
              detail: { text: `Tell me about this file: ${path}`, newSession: true },
            }),
          );
          window.dispatchEvent(
            new CustomEvent('stash:navigate', { detail: 'ai' }),
          );
          void api.hidePopup();
        },
      },
    ];
  }, [menu, toast]);

  return (
    <div className="flex flex-wrap gap-2">
      {paths.map((p) => (
        <Attachment
          key={p}
          path={p}
          onContextMenu={(e) => openContextMenu(e, p)}
        />
      ))}
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={items}
        onClose={() => setMenu(null)}
        label="File actions"
      />
    </div>
  );
};

const Attachment = ({
  path,
  onContextMenu,
}: {
  path: string;
  onContextMenu: (e: React.MouseEvent) => void;
}) => {
  const isImage = IMAGE_EXT.test(path);
  const isVideo = VIDEO_EXT.test(path);
  const isAudio = AUDIO_EXT.test(path);
  const src = normaliseFileSrc(path);
  const name = basename(path);

  const openExternal = () => {
    import('@tauri-apps/plugin-opener')
      .then((m) => m.openPath(path))
      .catch(() => undefined);
  };

  if (isImage) {
    return (
      <button
        type="button"
        onClick={openExternal}
        onContextMenu={onContextMenu}
        title={name}
        className="block rounded-lg overflow-hidden border hair hover:opacity-90 transition-opacity"
      >
        <img
          src={src}
          alt={name}
          className="block max-w-[200px] max-h-[160px] object-cover"
          draggable={false}
        />
      </button>
    );
  }
  if (isVideo) {
    return (
      <video
        src={src}
        controls
        onContextMenu={onContextMenu}
        className="rounded-lg max-w-[260px] max-h-[180px] border hair"
      />
    );
  }
  if (isAudio) {
    return (
      <audio
        src={src}
        controls
        onContextMenu={onContextMenu}
        className="rounded-lg"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={openExternal}
      onContextMenu={onContextMenu}
      title={path}
      className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border hair text-meta t-primary hover:bg-[var(--bg-hover)]"
    >
      <FileIcon />
      <span className="truncate max-w-[200px]">{name}</span>
    </button>
  );
};

const FileIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M3 1.5h5l3 3v8a.5.5 0 0 1-.5.5h-7.5a.5.5 0 0 1-.5-.5v-10.5a.5.5 0 0 1 .5-.5z" />
    <path d="M8 1.5v3h3" />
  </svg>
);

// ---------------------------- Composer ----------------------------

type ComposerProps = {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  onMic: () => void;
  status: Status;
  recorderLevel: number;
  commands: VoiceCommand[];
};

const Composer = ({
  value,
  onChange,
  onSend,
  onMic,
  status,
  recorderLevel,
  commands,
}: ComposerProps) => {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [suggestIndex, setSuggestIndex] = useState(0);

  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const max = LINE_HEIGHT * MAX_ROWS + V_PADDING;
    const scrollH = ta.scrollHeight;
    ta.style.height = `${Math.min(scrollH, max)}px`;
    ta.style.overflowY = scrollH > max ? 'auto' : 'hidden';
  }, [value]);

  // Show command suggestions only when the current line begins with `/`.
  // Match against the first whitespace-free token so `/timer 25` still
  // surfaces `/timer` while the user is filling in args (no dropdown).
  const suggestions = useMemo(() => {
    const trimmed = value.trimStart();
    if (!trimmed.startsWith('/')) return [];
    const token = trimmed.slice(1).split(/\s/, 1)[0] ?? '';
    if (trimmed.length > token.length + 1) return [];
    const needle = token.toLowerCase();
    return commands
      .filter((c) => c.name.startsWith(needle))
      .slice(0, 6);
  }, [value, commands]);

  useEffect(() => {
    setSuggestIndex(0);
  }, [suggestions.length]);

  const applySuggestion = (cmd: VoiceCommand) => {
    onChange(`/${cmd.name} `);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const canSend = status === 'idle' && value.trim().length > 0;
  const recording = status === 'recording';
  const busy = status === 'transcribing' || status === 'thinking';
  const micDisabled = busy;
  const ringScale = 1 + Math.min(recorderLevel * 1.6, 0.35);

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSuggestIndex((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSuggestIndex(
          (i) => (i - 1 + suggestions.length) % suggestions.length,
        );
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        const cmd = suggestions[suggestIndex];
        if (cmd) {
          e.preventDefault();
          applySuggestion(cmd);
          return;
        }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  return (
    <div className="relative border-t hair shrink-0">
      {suggestions.length > 0 && (
        <SuggestionList
          items={suggestions}
          activeIndex={suggestIndex}
          onPick={applySuggestion}
          onHover={setSuggestIndex}
        />
      )}
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onMic}
          disabled={micDisabled}
          aria-label={recording ? 'Stop recording' : 'Record voice'}
          aria-pressed={recording}
          title={
            recording
              ? 'Stop recording'
              : busy
                ? 'Working…'
                : 'Tap to talk (⌘⇧A)'
          }
          className="relative w-10 h-10 rounded-full flex items-center justify-center shrink-0 disabled:opacity-50 transition-transform"
          style={{
            backgroundColor: recording ? accent(0.55) : accent(0.2),
            color: 'rgb(var(--stash-accent-rgb))',
          }}
        >
          {recording && (
            <span
              aria-hidden
              className="absolute inset-0 rounded-full"
              style={{
                boxShadow: `0 0 0 3px ${accent(0.3)}`,
                transform: `scale(${ringScale})`,
                transition: 'transform 80ms linear',
              }}
            />
          )}
          {busy && status === 'transcribing' ? (
            <Spinner size={14} />
          ) : recording ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          ) : (
            <MicIcon />
          )}
        </button>
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
          onKeyDown={handleKey}
          placeholder="Запитай Stash або введи /команду…"
          rows={MIN_ROWS}
          maxLength={8000}
          className="flex-1 resize-none nice-scroll"
          style={{
            lineHeight: `${LINE_HEIGHT}px`,
            minHeight: `${LINE_HEIGHT * MIN_ROWS + V_PADDING}px`,
            maxHeight: `${LINE_HEIGHT * MAX_ROWS + V_PADDING}px`,
          }}
          aria-label="Voice popup input"
        />
        <button
          type="button"
          onClick={onSend}
          disabled={!canSend}
          aria-label="Send"
          title="Send (Enter)"
          className="relative w-10 h-10 rounded-full flex items-center justify-center shrink-0 disabled:opacity-40 transition-colors"
          style={{
            backgroundColor: canSend ? accent(0.55) : accent(0.18),
            color: 'rgb(var(--stash-accent-rgb))',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M2.5 2.5 L13.5 8 L2.5 13.5 L5.5 8 Z"
              fill="currentColor"
              stroke="currentColor"
              strokeLinejoin="round"
              strokeWidth="0.5"
            />
          </svg>
        </button>
      </div>
    </div>
  );
};

const SuggestionList = ({
  items,
  activeIndex,
  onPick,
  onHover,
}: {
  items: VoiceCommand[];
  activeIndex: number;
  onPick: (cmd: VoiceCommand) => void;
  onHover: (index: number) => void;
}) => (
  <div
    role="listbox"
    aria-label="Slash commands"
    className="absolute left-3 right-3 bottom-full mb-1 max-h-56 overflow-y-auto nice-scroll pane rounded-lg shadow-lg"
  >
    {items.map((cmd, i) => {
      const active = i === activeIndex;
      return (
        <button
          key={cmd.name}
          type="button"
          role="option"
          aria-selected={active}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            // Prevent the textarea from losing focus on click — the
            // suggestion picker mirrors Telegram's tap-to-fill behaviour.
            e.preventDefault();
            onPick(cmd);
          }}
          className="w-full text-left px-3 py-1.5 flex flex-col gap-0.5 text-meta hover:bg-[var(--color-hover)]"
          style={active ? { background: accent(0.16) } : undefined}
        >
          <div className="flex items-baseline gap-2">
            <span
              className="font-mono t-primary"
              style={active ? { color: 'rgb(var(--stash-accent-rgb))' } : undefined}
            >
              {cmd.usage}
            </span>
          </div>
          <span className="t-tertiary truncate">{cmd.description}</span>
        </button>
      );
    })}
  </div>
);

const MicIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M12 18v3" />
  </svg>
);

// ---------------------------- Quick commands ----------------------------

type QuickCommandTrayProps = {
  commands: QuickCommand[];
  onRun: (cmd: QuickCommand) => void;
  onEdit: (cmd: QuickCommand) => void;
  onDelete: (cmd: QuickCommand) => void;
  onAdd: () => void;
};

const QuickCommandTray = ({
  commands,
  onRun,
  onEdit,
  onDelete,
  onAdd,
}: QuickCommandTrayProps) => {
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    cmd: QuickCommand;
  } | null>(null);

  const items: ContextMenuItem[] = useMemo(() => {
    if (!menu) return [];
    return [
      { kind: 'action', label: 'Edit', onSelect: () => onEdit(menu.cmd) },
      { kind: 'separator' },
      {
        kind: 'action',
        label: 'Delete',
        tone: 'danger',
        onSelect: () => onDelete(menu.cmd),
      },
    ];
  }, [menu, onEdit, onDelete]);

  return (
    <div className="shrink-0 px-3 py-2 border-b hair">
      <div className="flex items-center gap-1.5 overflow-x-auto nice-scroll">
        {commands.map((cmd) => (
          <button
            key={cmd.id}
            type="button"
            onClick={() => onRun(cmd)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, cmd });
            }}
            title={cmd.prompt}
            className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-full border hair text-meta t-primary hover:bg-[var(--bg-hover)] transition-colors"
          >
            <span aria-hidden>{cmd.icon}</span>
            <span className="whitespace-nowrap">{cmd.label}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={onAdd}
          title="Add quick command"
          aria-label="Add quick command"
          className="shrink-0 w-7 h-7 rounded-full border hair flex items-center justify-center text-meta t-secondary hover:t-primary hover:bg-[var(--bg-hover)] transition-colors"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path
              d="M5 1v8M1 5h8"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={items}
        onClose={() => setMenu(null)}
        label="Quick command actions"
      />
    </div>
  );
};

type QuickCommandEditorProps = {
  initial: QuickCommand | null;
  onCancel: () => void;
  onSave: (cmd: QuickCommand) => void;
};

const QuickCommandEditor = ({
  initial,
  onCancel,
  onSave,
}: QuickCommandEditorProps) => {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [icon, setIcon] = useState(initial?.icon ?? '✨');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');

  const valid =
    label.trim().length > 0 &&
    icon.trim().length > 0 &&
    prompt.trim().length > 0;

  const submit = () => {
    if (!valid) return;
    onSave({
      id: initial?.id ?? makeId(),
      label: label.trim(),
      icon: icon.trim(),
      prompt,
    });
  };

  return (
    <Modal
      open
      onClose={onCancel}
      ariaLabel={initial ? 'Edit quick command' : 'New quick command'}
      maxWidth={420}
    >
      <div className="flex flex-col gap-3">
        <div className="t-primary text-title">
          {initial ? 'Edit quick command' : 'New quick command'}
        </div>
        <label className="flex flex-col gap-1">
          <span className="t-secondary text-meta">Label</span>
          <Input
            value={label}
            onChange={(e) => setLabel(e.currentTarget.value)}
            placeholder="Notes, Translate, Claude…"
            autoFocus
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="t-secondary text-meta">Icon (emoji)</span>
          <Input
            value={icon}
            onChange={(e) => setIcon(e.currentTarget.value)}
            placeholder="📝"
            maxLength={4}
            className="w-20"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="t-secondary text-meta">Prompt</span>
          <Input
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
            placeholder="/note  or  Translate this to English: "
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <span className="t-tertiary text-meta">
            Закінчи пробілом (наприклад <code>/note </code>) щоб команда
            відкривала ввід для аргументів замість запуску одразу.
          </span>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" tone="neutral" onClick={onCancel} size="sm">
            Cancel
          </Button>
          <Button
            variant="soft"
            tone="accent"
            onClick={submit}
            disabled={!valid}
            size="sm"
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
};

// ---------------------------- Pending attachments ----------------------------

type PendingAttachmentStripProps = {
  paths: string[];
  onRemove: (p: string) => void;
};

const PendingAttachmentStrip = ({
  paths,
  onRemove,
}: PendingAttachmentStripProps) => (
  <div className="shrink-0 px-3 py-2 border-t hair flex items-center gap-2 overflow-x-auto nice-scroll">
    {paths.map((p) => {
      const isImage = IMAGE_EXT.test(p);
      const name = basename(p);
      return (
        <div
          key={p}
          className="relative shrink-0 group"
          title={p}
        >
          {isImage ? (
            <img
              src={normaliseFileSrc(p)}
              alt={name}
              className="block w-12 h-12 object-cover rounded border hair"
              draggable={false}
            />
          ) : (
            <div className="flex items-center gap-1.5 px-2 py-1.5 rounded border hair text-meta t-primary">
              <FileIcon />
              <span className="truncate max-w-[140px]">{name}</span>
            </div>
          )}
          <button
            type="button"
            aria-label="Remove attachment"
            title="Remove"
            onClick={() => onRemove(p)}
            className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-[var(--color-bg-elev)] border hair t-primary flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
              <path
                d="M1 1l6 6M7 1l-6 6"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      );
    })}
  </div>
);
