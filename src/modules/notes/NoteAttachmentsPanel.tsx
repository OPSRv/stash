import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';

import { AudioPlayer } from '../../shared/ui/AudioPlayer';
import { revealFile } from '../../shared/util/revealFile';
import { Badge } from '../../shared/ui/Badge';
import { Button } from '../../shared/ui/Button';
import { FileChip, formatBytes } from '../../shared/ui/FileChip';
import { IconButton } from '../../shared/ui/IconButton';
import { ImageThumbnail } from '../../shared/ui/ImageThumbnail';
import { InlineVideo } from '../../shared/ui/InlineVideo';
import { TranscriptArea } from '../../shared/ui/TranscriptArea';
import { useTranscription } from '../../shared/hooks/useTranscription';
import type { TranscriptionHandlers } from '../../shared/hooks/useTranscription';
import {
  notesAddAttachment,
  notesListAttachments,
  notesRemoveAttachment,
  notesTranscribeAttachment,
  notesSetAttachmentTranscription,
  type NoteAttachment,
} from './api';

type Props = {
  noteId: number;
  /// Opt-in callback: when supplied, each attachment row surfaces an
  /// "Embed in body" affordance that asks the parent to paste a
  /// markdown reference into the editor. Left undefined in tests.
  onEmbedMarkdown?: (snippet: string) => void;
};

const basename = (p: string) => p.replace(/^.*[\\/]/, '');

const kindOf = (a: NoteAttachment): 'image' | 'video' | 'audio' | 'file' => {
  const m = (a.mime_type ?? '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'file';
};

/// Attachments rail for a single note. Supports drag-and-drop (files
/// landed anywhere in the app while a note is active get attached) and
/// a classic "+ Add file" picker. Media kinds get inline renderers so
/// the user can skim a note without leaving the popup.
const markdownForAttachment = (a: NoteAttachment): string => {
  const url = `file://${a.file_path}`;
  const alt = a.original_name || 'attachment';
  const kind = kindOf(a);
  if (kind === 'image') return `![${alt}](${url})`;
  if (kind === 'audio' || kind === 'video') return `![${alt}](${url})`;
  return `[${alt}](${url})`;
};

export const NoteAttachmentsPanel = ({ noteId, onEmbedMarkdown }: Props) => {
  const [items, setItems] = useState<NoteAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Holds the latest fetched list so `onRefreshAndGetTranscription` can
  // look up the updated item without an extra round-trip.
  const itemsRef = useRef<NoteAttachment[]>([]);

  const refresh = useCallback(async (): Promise<NoteAttachment[]> => {
    try {
      const out = await notesListAttachments(noteId);
      const next = Array.isArray(out) ? out : [];
      setItems(next);
      itemsRef.current = next;
      return next;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return itemsRef.current;
    }
  }, [noteId]);

  /// Called by AudioAttachmentBody when `notes:attachment_updated` fires.
  /// Refreshes the list then returns the new transcription for the given id.
  const onRefreshAndGetTranscription = useCallback(
    async (id: number): Promise<string | null> => {
      const fresh = await refresh();
      return fresh.find((a) => a.id === id)?.transcription ?? null;
    },
    [refresh],
  );

  useEffect(() => {
    void refresh();
    const unl = listen<number>('notes:attachments_changed', () => {
      void refresh();
    });
    return () => {
      void unl.then((f) => f());
    };
  }, [refresh]);

  // Native drag-and-drop. Subscribe exactly once on mount — repeatedly
  // re-subscribing when noteId/refresh change causes rapid sub/unsub
  // churn that races Tauri's event bookkeeping and surfaces as silent
  // drops. We read the current noteId via a ref so the single long-
  // lived handler always attaches to whatever note is active now.
  const noteIdRef = useRef(noteId);
  useEffect(() => {
    noteIdRef.current = noteId;
  }, [noteId]);
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  const [dropActive, setDropActive] = useState(false);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void getCurrentWebview()
      .onDragDropEvent(async (event) => {
        const p = event.payload;
        if (p.type === 'enter') {
          if ((p.paths?.length ?? 0) > 0) setDropActive(true);
          return;
        }
        if (p.type === 'over') {
          setDropActive(true);
          return;
        }
        if (p.type === 'leave') {
          setDropActive(false);
          return;
        }
        if (p.type !== 'drop') return;
        setDropActive(false);
        const paths = p.paths;
        if (!paths || paths.length === 0) return;
        const currentNote = noteIdRef.current;
        if (currentNote == null) return;
        setBusy(true);
        setError(null);
        try {
          for (const path of paths) {
            await notesAddAttachment(currentNote, path);
          }
          await refreshRef.current();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* Outside Tauri (tests, Vite preview) — no-op. */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const addFromPicker = async () => {
    setError(null);
    // Suspend popup auto-hide while the native picker is up — per
    // CLAUDE.md convention, otherwise focusing the dialog blurs the
    // popup and the blur handler hides us, which in turn dismisses the
    // dialog before the user can pick anything.
    await invoke('set_popup_auto_hide', { enabled: false }).catch(() => {});
    let selected: string | string[] | null = null;
    try {
      selected = await openDialog({ multiple: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    } finally {
      await invoke('set_popup_auto_hide', { enabled: true }).catch(() => {});
    }
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    setBusy(true);
    try {
      for (const p of paths) {
        await notesAddAttachment(noteId, p);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    setError(null);
    setBusy(true);
    try {
      await notesRemoveAttachment(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (items.length === 0 && !busy) {
    return (
      <div
        className={`px-5 pt-3 pb-4 transition-colors ${
          dropActive ? 'bg-[rgba(var(--stash-accent-rgb),0.08)]' : ''
        }`}
      >
        <div className="flex items-center gap-2.5 text-meta t-tertiary">
          <Button size="xs" variant="ghost" onClick={addFromPicker}>
            + Attach file
          </Button>
          <span className="t-tertiary/80">
            {dropActive ? 'Release to attach' : 'or drop a file onto this window'}
          </span>
        </div>
        {error && (
          <p role="alert" className="mt-2 text-meta text-rose-300/90">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      className={`px-5 pt-3 pb-4 flex flex-col gap-2 transition-colors ${
        dropActive ? 'bg-[rgba(var(--stash-accent-rgb),0.08)]' : ''
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-meta font-semibold uppercase tracking-wider text-white/40">
          Attachments · {items.length}
        </span>
        <span className="h-px flex-1 bg-white/5" />
        <Button size="xs" variant="ghost" onClick={addFromPicker} disabled={busy}>
          + Attach file
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-meta text-rose-300/90">
          {error}
        </p>
      )}
      <ul className="flex flex-wrap gap-2">
        {items.map((a) => {
          // Audio attachments take the full row — the waveform reads
          // poorly when squeezed to 260 px next to a thumbnail, and
          // the inline transcript wants the horizontal real estate.
          // Other kinds (image / video / file) keep flex-wrap'ing so
          // a few small items can sit side-by-side.
          const fullRow = kindOf(a) === 'audio';
          const actions = (
            <AttachmentActions
              item={a}
              busy={busy}
              onEmbedMarkdown={onEmbedMarkdown}
              onRemove={remove}
            />
          );
          if (fullRow) {
            return (
              <li
                key={a.id}
                className="group w-full rounded-lg border border-white/8 bg-white/3 px-3 py-2.5 flex flex-col gap-2"
              >
                <div className="flex items-center gap-2">
                  <Badge color="#4A8BEA" bg="#4A8BEA1a" className="uppercase tracking-wider">
                    Audio
                  </Badge>
                  <span
                    className="t-secondary text-meta truncate min-w-0 flex-1"
                    title={a.original_name}
                  >
                    {a.original_name || basename(a.file_path)}
                  </span>
                  <span className="t-tertiary text-meta tabular-nums shrink-0">
                    {formatBytes(a.size_bytes)}
                  </span>
                  <div className="ml-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    {actions}
                  </div>
                </div>
                <AttachmentBody
                  item={a}
                  onRefreshAndGetTranscription={onRefreshAndGetTranscription}
                />
              </li>
            );
          }
          return (
            <li
              key={a.id}
              className="group relative rounded-lg border border-white/8 bg-white/3 overflow-hidden flex items-center"
            >
              <AttachmentBody
                item={a}
                onRefreshAndGetTranscription={onRefreshAndGetTranscription}
              />
              <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                {actions}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

const AttachmentActions = ({
  item,
  busy,
  onEmbedMarkdown,
  onRemove,
}: {
  item: NoteAttachment;
  busy: boolean;
  onEmbedMarkdown?: (snippet: string) => void;
  onRemove: (id: number) => Promise<void> | void;
}) => (
  <>
    {onEmbedMarkdown && (
      <IconButton
        title="Embed in note body as markdown"
        onClick={() => onEmbedMarkdown(markdownForAttachment(item))}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4 6h16M4 12h10M4 18h16" />
        </svg>
      </IconButton>
    )}
    <IconButton
      title="Reveal in Finder"
      onClick={() => void revealFile(item.file_path)}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 7h6l2 2h10v10a2 2 0 0 1-2 2H3z" />
      </svg>
    </IconButton>
    <IconButton
      title="Remove attachment"
      tone="danger"
      onClick={() => void onRemove(item.id)}
      disabled={busy}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6" />
      </svg>
    </IconButton>
  </>
);

const AttachmentBody = ({
  item,
  onRefreshAndGetTranscription,
}: {
  item: NoteAttachment;
  onRefreshAndGetTranscription: (id: number) => Promise<string | null>;
}) => {
  const kind = kindOf(item);
  switch (kind) {
    case 'image':
      return (
        <div className="px-2 py-2">
          <ImageThumbnail src={item.file_path} alt={item.original_name} />
        </div>
      );
    case 'video':
      return (
        <div className="px-2 py-2">
          <InlineVideo src={item.file_path} />
        </div>
      );
    case 'audio':
      return (
        <AudioAttachmentBody
          item={item}
          onRefreshAndGetTranscription={onRefreshAndGetTranscription}
        />
      );
    case 'file':
    default:
      return (
        <div className="px-3 py-2.5 min-w-[220px]">
          <FileChip
            name={basename(item.original_name) || basename(item.file_path)}
            mimeType={item.mime_type}
            size={formatBytes(item.size_bytes)}
          />
        </div>
      );
  }
};

/// Audio attachment with an inline Whisper transcript panel. Subscribes to
/// the three backend transcription events for this specific attachment id.
const AudioAttachmentBody = ({
  item,
  onRefreshAndGetTranscription,
}: {
  item: NoteAttachment;
  onRefreshAndGetTranscription: (id: number) => Promise<string | null>;
}) => {
  const subscribe = useCallback(
    (handlers: TranscriptionHandlers) => {
      const fns: Array<Promise<() => void>> = [];

      fns.push(
        listen<{ id: number }>('notes:attachment_transcribing', (e) => {
          if (e.payload.id === item.id) handlers.onStart();
        }),
      );

      fns.push(
        listen<{ id: number }>('notes:attachment_updated', async (e) => {
          if (e.payload.id !== item.id) return;
          const t = await onRefreshAndGetTranscription(item.id);
          if (t != null) handlers.onDone(t);
        }),
      );

      fns.push(
        listen<{ id: number; error: string }>('notes:attachment_transcribe_failed', (e) => {
          if (e.payload.id === item.id) handlers.onFailed(e.payload.error);
        }),
      );

      return () => {
        fns.forEach((p) => void p.then((fn) => fn()));
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [item.id],
  );

  const { status, transcript, failed, transcribe } = useTranscription({
    initial: item.transcription,
    start: () => notesTranscribeAttachment(item.id),
    subscribe,
  });

  return (
    <div className="w-full flex flex-col gap-2">
      {/* Stream attachments over the loopback HTTP server. `asset://`
          can't reach AVFoundation (which `<audio>` falls back to for
          large/streaming media), so the local server is the only path
          that works for note attachments — no IPC byte transfer, full
          Range-request seeking. */}
      <AudioPlayer src={item.file_path} loader="stream" />
      <TranscriptArea
        transcript={transcript}
        transcribing={status === 'running'}
        failed={failed}
        onRetry={transcribe}
        onTranscribe={transcribe}
        onEdit={(t) => notesSetAttachmentTranscription(item.id, t)}
      />
    </div>
  );
};
