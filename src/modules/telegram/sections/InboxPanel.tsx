import { useCallback, useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { appDataDir, join } from '@tauri-apps/api/path';

import { IconButton } from '../../../shared/ui/IconButton';
import * as api from '../api';
import type { InboxItem } from '../types';
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

/// Bucket items by received_at into `Today`, `Yesterday`, then one
/// bucket per older day. Keeps insertion order (which is already
/// descending by received_at from the backend).
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

export function InboxPanel() {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState<Set<number>>(new Set());
  const [failed, setFailed] = useState<Set<number>>(new Set());

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
          // `appDataDir()` in tests is mocked to a literal path; treat
          // anything already absolute as passthrough so we don't
          // double-prefix. On macOS that's "starts with /".
          if (row.file_path.startsWith('/')) return row;
          const abs = await join(base, row.file_path);
          return { ...row, file_path: abs };
        }),
      );
      setItems(resolved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    let unlisten: (() => void) | undefined;
    Promise.all([
      listen<number>('telegram:inbox_added', () => refresh()),
      listen<number>('telegram:inbox_updated', (e) => {
        // Transcript landed — clear the in-flight marker for this id.
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

  const groups = useMemo(() => (items ? groupByDay(items) : []), [items]);

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

  if (!items) return null;

  return (
    <section className="h-full overflow-y-auto nice-scroll">
      {error && (
        <p
          role="alert"
          className="mx-4 mt-3 text-[12px] text-rose-300/90 bg-rose-500/10 border border-rose-500/20 rounded-md px-3 py-2"
        >
          {error}
        </p>
      )}
      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 px-8 text-center gap-2">
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center"
            style={{ backgroundColor: 'rgba(var(--stash-accent-rgb), 0.10)' }}
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
          <h3 className="text-[15px] font-medium text-white/90">Inbox is empty</h3>
          <p className="text-[12px] text-white/50 max-w-xs">
            Send the bot a message, voice note, photo, video, or document and it
            will land here.
          </p>
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
              <ul className="flex flex-col" aria-label={`Inbox — ${group.label}`}>
                {group.items.map((item) => (
                  <li
                    key={item.id}
                    data-testid={`inbox-item-${item.id}`}
                    className="mx-2 my-0.5 px-3 py-2.5 rounded-lg hover:bg-white/3 transition-colors flex flex-col gap-2 group"
                  >
                    <div className="flex items-center gap-2 text-[11px] text-white/40">
                      <KindBadge kind={item.kind} />
                      <span className="font-mono tabular-nums">
                        {formatTime(item.received_at)}
                      </span>
                      {item.routed_to && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-white/60">
                          → {item.routed_to}
                        </span>
                      )}
                      <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                        <RowAction
                          label="Save to Notes"
                          disabled={busyId === item.id || item.routed_to === 'notes'}
                          onClick={() =>
                            runOn(item.id, async () => {
                              await api.sendInboxToNotes(item.id);
                              // Hop to the Notes tab so the user sees
                              // the freshly-created entry + attachment
                              // right away — without this the save
                              // looks silent.
                              window.dispatchEvent(
                                new CustomEvent('stash:navigate', {
                                  detail: 'notes',
                                }),
                              );
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
                            disabled={busyId === item.id || !!item.routed_to}
                            onClick={() =>
                              runOn(item.id, () =>
                                api.markInboxRouted(item.id, 'clipboard'),
                              )
                            }
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
                            disabled={busyId === item.id}
                            onClick={() =>
                              runOn(item.id, () => api.revealInboxFile(item.id))
                            }
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
                          disabled={busyId === item.id}
                          onClick={() =>
                            runOn(item.id, () => api.deleteInboxItem(item.id))
                          }
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
                      transcribing={transcribing.has(item.id)}
                      failed={failed.has(item.id)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

type InboxBodyProps = {
  item: InboxItem;
  transcribing: boolean;
  failed: boolean;
};

const InboxBody = ({ item, transcribing, failed }: InboxBodyProps) => {
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
    <span
      className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded"
      style={{
        color: meta.color,
        backgroundColor: `${meta.color}1a`,
      }}
    >
      {meta.label}
    </span>
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
