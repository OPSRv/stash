import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { appDataDir, join } from '@tauri-apps/api/path';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { invoke } from '@tauri-apps/api/core';

import { accent } from '../../../shared/theme/accent';
import { Badge } from '../../../shared/ui/Badge';
import { IconButton } from '../../../shared/ui/IconButton';
import { SearchInput } from '../../../shared/ui/SearchInput';
import { Button } from '../../../shared/ui/Button';
import * as api from '../api';
import type { ConnectionStatus, InboxItem } from '../types';
import {
  DocumentItem,
  PhotoItem,
  TextItem,
  VideoItem,
} from './inbox/MediaItems';
import { VoiceItem } from './inbox/VoiceItem';

type Group = {
  label: string;
  items: InboxItem[];
};

const ONE_DAY = 24 * 60 * 60;

const startOfDay = (unix: number) => {
  const d = new Date(unix * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
};

const basenameFromPath = (p: string | null): string =>
  p ? p.replace(/^.*[\\/]/, '') : '';

/// Text haystack for the in-inbox search field. Hits on message body,
/// transcript, caption and attached filename — everything a user
/// would type to find an item.
const haystack = (item: InboxItem): string =>
  [
    item.text_content ?? '',
    item.transcript ?? '',
    item.caption ?? '',
    basenameFromPath(item.file_path),
    item.kind,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

const groupByDay = (items: InboxItem[]): Group[] => {
  if (items.length === 0) return [];
  const today = startOfDay(Math.floor(Date.now() / 1000));
  const yesterday = today - ONE_DAY;
  const buckets = new Map<number, InboxItem[]>();
  for (const it of items) {
    const day = startOfDay(it.received_at);
    const bucket = buckets.get(day) ?? [];
    bucket.push(it);
    buckets.set(day, bucket);
  }
  const out: Group[] = [];
  for (const [day, bucket] of buckets) {
    let label: string;
    if (day === today) label = 'Today';
    else if (day === yesterday) label = 'Yesterday';
    else {
      const d = new Date(day * 1000);
      label = d.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
    }
    out.push({ label, items: bucket });
  }
  return out;
};

const formatTime = (unix: number) =>
  new Date(unix * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });

const navigateTo = (tab: string) => {
  window.dispatchEvent(new CustomEvent('stash:navigate', { detail: tab }));
};

const openSettingsTelegram = () => {
  navigateTo('settings');
  queueMicrotask(() =>
    window.dispatchEvent(
      new CustomEvent('stash:settings-section', { detail: 'telegram' }),
    ),
  );
};

const isPaired = (s: ConnectionStatus | null) => s?.kind === 'paired';

export function InboxPanel() {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState<Set<number>>(new Set());
  const [failed, setFailed] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await api.listInbox();
      // Backend stores `file_path` relative to the app data dir. The
      // asset protocol (used by <img>, <audio>, <video>) needs an
      // absolute path, so we resolve once and rewrite the field in
      // place before handing the list to the renderer.
      const base = await appDataDir();
      const resolved = await Promise.all(
        rows.map(async (row): Promise<InboxItem> => {
          if (!row.file_path) return row;
          if (row.file_path.startsWith('/')) return row;
          const abs = await join(base, row.file_path);
          return { ...row, file_path: abs };
        }),
      );
      setItems(resolved);
      // Prune selections that no longer refer to existing rows —
      // happens after a bulk-delete round-trip.
      setSelection((prev) => {
        const next = new Set<number>();
        for (const r of resolved) if (prev.has(r.id)) next.add(r.id);
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Pull connection status once so the empty-state can steer the user
    // to Settings when the bot isn't paired yet.
    void api
      .status()
      .then(setConnection)
      .catch(() => setConnection(null));
    let unlisten: (() => void) | undefined;
    Promise.all([
      listen<number>('telegram:inbox_added', () => refresh()),
      listen<number>('telegram:inbox_updated', (e) => {
        setTranscribing((prev) => {
          if (!prev.has(e.payload)) return prev;
          const next = new Set(prev);
          next.delete(e.payload);
          return next;
        });
        setFailed((prev) => {
          if (!prev.has(e.payload)) return prev;
          const next = new Set(prev);
          next.delete(e.payload);
          return next;
        });
        void refresh();
      }),
      listen<number>('telegram:transcribing', (e) => {
        setTranscribing((prev) => new Set(prev).add(e.payload));
      }),
      listen<number>('telegram:transcribe_failed', (e) => {
        setTranscribing((prev) => {
          const next = new Set(prev);
          next.delete(e.payload);
          return next;
        });
        setFailed((prev) => new Set(prev).add(e.payload));
      }),
    ]).then((unsubs) => {
      unlisten = () => unsubs.forEach((u) => u());
    });
    return () => {
      unlisten?.();
    };
  }, [refresh]);

  // Drag-and-drop: dropping a file onto the panel creates a fresh
  // note with that file attached. Telegram inbox is the right surface
  // for this because the whole point of the panel is "things coming in
  // from outside".
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (!active || event.payload.type !== 'drop') return;
        const paths = event.payload.paths;
        if (!paths || paths.length === 0) return;
        setError(null);
        try {
          // Create a lightweight note per file, attach the file. We
          // route through the Notes commands directly — the same
          // backend logic that Telegram inbox → note uses.
          for (const p of paths) {
            const filename = p.replace(/^.*[\\/]/, '');
            const noteId = await invoke<number>('notes_create', {
              title: filename || 'Dropped file',
              body: '',
            });
            await invoke('notes_add_attachment', {
              noteId,
              sourcePath: p,
            });
          }
          navigateTo('notes');
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .then((u) => {
        unlisten = u;
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const visibleItems = useMemo(() => {
    if (!items) return [];
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => haystack(it).includes(q));
  }, [items, query]);

  const groups = useMemo(() => groupByDay(visibleItems), [visibleItems]);

  const runOn = async (id: number, fn: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const toggleSelect = (id: number) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelection(new Set());

  const bulkDelete = async () => {
    setError(null);
    const ids = Array.from(selection);
    for (const id of ids) {
      try {
        await api.deleteInboxItem(id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    clearSelection();
    await refresh();
  };

  const bulkSaveToNotes = async () => {
    setError(null);
    const ids = Array.from(selection);
    for (const id of ids) {
      try {
        await api.sendInboxToNotes(id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    clearSelection();
    await refresh();
    navigateTo('notes');
  };

  if (!items) return null;

  const hasItems = items.length > 0;
  const noMatches = hasItems && visibleItems.length === 0;
  const selCount = selection.size;

  return (
    <section
      ref={panelRef}
      className="h-full flex flex-col"
      aria-label="Telegram inbox"
    >
      {hasItems && (
        <div className="border-b border-white/5 flex items-center gap-2">
          {selCount === 0 ? (
            <div className="flex-1">
              <SearchInput
                value={query}
                onChange={setQuery}
                placeholder="Search inbox"
                compact
              />
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-2 flex-1">
              <span className="text-[12px] text-white/70 font-medium">
                {selCount} selected
              </span>
              <div className="ml-auto flex items-center gap-1">
                <Button size="xs" variant="ghost" onClick={clearSelection}>
                  Clear
                </Button>
                <Button
                  size="xs"
                  variant="soft"
                  tone="accent"
                  onClick={() => void bulkSaveToNotes()}
                >
                  Save to Notes
                </Button>
                <Button
                  size="xs"
                  variant="soft"
                  tone="danger"
                  onClick={() => void bulkDelete()}
                >
                  Delete
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="mx-4 mt-3 text-[12px] text-rose-300/90 bg-rose-500/10 border border-rose-500/20 rounded-md px-3 py-2"
        >
          {error}
        </p>
      )}
      <div className="flex-1 overflow-y-auto nice-scroll">
        {!hasItems ? (
          <EmptyState connection={connection} />
        ) : noMatches ? (
          <div className="px-8 py-12 text-center text-[12px] text-white/45">
            Nothing matches “{query}”.
          </div>
        ) : (
          <div className="flex flex-col">
            {groups.map((group) => (
              <div key={group.label} className="flex flex-col">
                <div className="px-4 pt-4 pb-1.5 flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-white/35">
                    {group.label}
                  </span>
                  <span className="h-px flex-1 bg-white/5" />
                </div>
                <ul
                  className="flex flex-col"
                  aria-label={`Inbox — ${group.label}`}
                >
                  {group.items.map((item) => (
                    <InboxRow
                      key={item.id}
                      item={item}
                      selected={selection.has(item.id)}
                      busy={busyId === item.id}
                      transcribing={transcribing.has(item.id)}
                      failed={failed.has(item.id)}
                      onToggleSelect={() => toggleSelect(item.id)}
                      onAction={(fn) => runOn(item.id, fn)}
                      onEditTranscript={async (next) => {
                        await api.setInboxTranscript(item.id, next);
                      }}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

type InboxRowProps = {
  item: InboxItem;
  selected: boolean;
  busy: boolean;
  transcribing: boolean;
  failed: boolean;
  onToggleSelect: () => void;
  onAction: (fn: () => Promise<unknown>) => void;
  onEditTranscript: (next: string) => Promise<void>;
};

const InboxRow = ({
  item,
  selected,
  busy,
  transcribing,
  failed,
  onToggleSelect,
  onAction,
  onEditTranscript,
}: InboxRowProps) => (
  <li
    data-testid={`inbox-item-${item.id}`}
    role="option"
    aria-selected={selected}
    tabIndex={0}
    onClick={(e) => {
      // Clicks on interactive children (RowAction buttons, voice
      // player, transcript editor, links) must not double as a select
      // toggle. Anything inside an explicit control element is ignored.
      const t = e.target as HTMLElement;
      if (t.closest('button, input, textarea, audio, a, [data-no-select]')) return;
      onToggleSelect();
    }}
    onKeyDown={(e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        const t = e.target as HTMLElement;
        if (t.closest('button, input, textarea, audio, a, [data-no-select]')) return;
        e.preventDefault();
        onToggleSelect();
      }
    }}
    className={`mx-2 my-0.5 px-3 py-2.5 rounded-lg transition-colors flex flex-col gap-2 group cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--stash-accent-rgb))] ${
      selected ? 'bg-[rgba(var(--stash-accent-rgb),0.18)]' : 'hover:bg-white/3'
    }`}
  >
    <div className="flex items-center gap-2 text-[11px] text-white/40">
      {/* Hidden checkbox kept purely for assistive tech + form
          semantics — the visible "click anywhere on the row" affordance
          is the li itself. `sr-only` removes it from the layout while
          keeping it in the accessibility tree. */}
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelect}
        className="sr-only"
        aria-label={`Select item ${item.id}`}
      />
      <KindBadge kind={item.kind} />
      <span className="font-mono tabular-nums">{formatTime(item.received_at)}</span>
      {item.routed_to && <Badge tone="neutral">→ {item.routed_to}</Badge>}
      <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <RowAction
          label="Save to Notes"
          disabled={busy || item.routed_to === 'notes'}
          onClick={() =>
            onAction(async () => {
              await api.sendInboxToNotes(item.id);
              navigateTo('notes');
            })
          }
          icon={
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 4h12l4 4v12a2 2 0 0 1-2 2H4z" />
              <path d="M16 4v4h4" />
              <path d="M8 12h8M8 16h6" />
            </svg>
          }
        />
        {item.kind === 'text' && (
          <RowAction
            label="Route to Clipboard"
            disabled={busy || !!item.routed_to}
            onClick={() => onAction(() => api.markInboxRouted(item.id, 'clipboard'))}
            icon={
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="8" y="2" width="8" height="4" rx="1" />
                <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
              </svg>
            }
          />
        )}
        {item.file_path && (
          <RowAction
            label="Reveal in Finder"
            disabled={busy}
            onClick={() => onAction(() => api.revealInboxFile(item.id))}
            icon={
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 7h6l2 2h10v10a2 2 0 0 1-2 2H3z" />
              </svg>
            }
          />
        )}
        <RowAction
          label="Delete"
          tone="danger"
          disabled={busy}
          onClick={() => onAction(() => api.deleteInboxItem(item.id))}
          icon={
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6" />
            </svg>
          }
        />
      </div>
    </div>
    <InboxBody
      item={item}
      transcribing={transcribing}
      failed={failed}
      onRetryTranscribe={async () => {
        await api.retryTranscribe(item.id);
      }}
      onEditTranscript={onEditTranscript}
    />
  </li>
);

type InboxBodyProps = {
  item: InboxItem;
  transcribing: boolean;
  failed: boolean;
  onRetryTranscribe: () => Promise<void>;
  onEditTranscript: (next: string) => Promise<void>;
};

const InboxBody = ({
  item,
  transcribing,
  failed,
  onRetryTranscribe,
  onEditTranscript,
}: InboxBodyProps) => {
  switch (item.kind) {
    case 'text':
      return <TextItem content={item.text_content ?? ''} />;
    case 'voice':
      return item.file_path ? (
        <VoiceItem
          filePath={item.file_path}
          durationSec={item.duration_sec}
          transcript={item.transcript}
          transcribing={transcribing}
          failed={failed}
          onRetry={() => void onRetryTranscribe()}
          onEditTranscript={onEditTranscript}
        />
      ) : (
        <TextItem content="[voice file missing]" />
      );
    case 'photo':
      return item.file_path ? (
        <PhotoItem filePath={item.file_path} caption={item.caption} />
      ) : (
        <TextItem content="[photo file missing]" />
      );
    case 'video':
      return item.file_path ? (
        <VideoItem
          filePath={item.file_path}
          caption={item.caption}
          durationSec={item.duration_sec}
        />
      ) : (
        <TextItem content="[video file missing]" />
      );
    case 'document':
    case 'sticker':
      return item.file_path ? (
        <DocumentItem
          filePath={item.file_path}
          mimeType={item.mime_type}
          caption={item.caption}
        />
      ) : (
        <TextItem content={`[${item.kind}]`} />
      );
    default:
      return <TextItem content={item.text_content ?? `[${item.kind}]`} />;
  }
};

const EmptyState = ({ connection }: { connection: ConnectionStatus | null }) => {
  const paired = isPaired(connection);
  return (
    <div className="flex flex-col items-center justify-center py-16 px-8 text-center gap-3">
      <div
        className="w-12 h-12 rounded-full flex items-center justify-center"
        style={{ backgroundColor: accent(0.10) }}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          style={{ color: 'rgb(var(--stash-accent-rgb))' }}
        >
          <path d="M21.5 4.5 2.5 11.5l6 2m13-9-10 14-3-5m13-9-10 7" />
        </svg>
      </div>
      <h3 className="text-[15px] font-medium text-white/90">
        {paired ? 'Inbox is empty' : 'Connect Telegram first'}
      </h3>
      <p className="text-[12px] text-white/50 max-w-xs">
        {paired
          ? 'Send the bot a message, voice note, photo, video, or document and it will land here.'
          : 'Pair a Telegram bot in Settings to start receiving messages in Stash.'}
      </p>
      {!paired && (
        <Button size="sm" variant="soft" tone="accent" onClick={openSettingsTelegram}>
          Open Telegram settings
        </Button>
      )}
    </div>
  );
};

const KIND_META: Record<
  string,
  { label: string; color: string }
> = {
  text: { label: 'Text', color: 'rgba(255,255,255,0.45)' },
  voice: { label: 'Voice', color: '#4A8BEA' },
  photo: { label: 'Photo', color: '#7B54E8' },
  video: { label: 'Video', color: '#EA8B4A' },
  document: { label: 'Doc', color: '#5BC88A' },
  sticker: { label: 'Sticker', color: '#EAD24A' },
};

const KindBadge = ({ kind }: { kind: string }) => {
  const meta = KIND_META[kind] ?? { label: kind, color: 'rgba(255,255,255,0.45)' };
  return (
    <Badge color={meta.color} bg={`${meta.color}1a`} className="uppercase tracking-wider">
      {meta.label}
    </Badge>
  );
};

type RowActionProps = {
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  tone?: 'default' | 'danger';
  onClick: () => void;
};

const RowAction = ({ label, icon, disabled, tone, onClick }: RowActionProps) => (
  <IconButton title={label} disabled={disabled} tone={tone} onClick={onClick}>
    {icon}
  </IconButton>
);
