import { useCallback, useEffect, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';

import { AudioPlayer } from '../../shared/ui/AudioPlayer';
import { Button } from '../../shared/ui/Button';
import { IconButton } from '../../shared/ui/IconButton';
import {
  notesAddAttachment,
  notesListAttachments,
  notesRemoveAttachment,
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

const formatBytes = (n: number | null | undefined) => {
  if (!n || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
};

const kindOf = (a: NoteAttachment): 'image' | 'video' | 'audio' | 'file' => {
  const m = (a.mime_type ?? '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'file';
};

const revealInFinder = async (path: string) => {
  // Lean on the existing opener plugin so the native reveal call stays
  // sandboxed behind a single permission allow-list.
  await invoke('plugin:opener|reveal_item_in_dir', { path }).catch(() =>
    invoke('plugin:opener|open_path', { path }),
  );
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

  const refresh = useCallback(async () => {
    try {
      const out = await notesListAttachments(noteId);
      setItems(Array.isArray(out) ? out : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [noteId]);

  useEffect(() => {
    void refresh();
    const unl = listen<number>('notes:attachments_changed', () => {
      void refresh();
    });
    return () => {
      void unl.then((f) => f());
    };
  }, [refresh]);

  // Native drag-and-drop. Tauri's webview event fires when the user
  // drops a file over the window; we intercept only while this panel is
  // mounted (i.e. a note is active).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (event.payload.type !== 'drop') return;
        const paths = event.payload.paths;
        if (!paths || paths.length === 0) return;
        setBusy(true);
        setError(null);
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
      })
      .then((u) => {
        unlisten = u;
      });
    return () => {
      unlisten?.();
    };
  }, [noteId, refresh]);

  const addFromPicker = async () => {
    setError(null);
    let selected: string | string[] | null = null;
    try {
      selected = await openDialog({ multiple: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
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

  if (items.length === 0 && !busy && !error) {
    return (
      <div className="px-4 pb-3">
        <Button size="xs" variant="ghost" onClick={addFromPicker}>
          + Attach file
        </Button>
        <span className="ml-3 text-[11px] text-white/35">
          or drag a file onto this window
        </span>
      </div>
    );
  }

  return (
    <div className="px-4 pb-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-white/40">
          Attachments · {items.length}
        </span>
        <span className="h-px flex-1 bg-white/5" />
        <Button size="xs" variant="ghost" onClick={addFromPicker} disabled={busy}>
          + Attach file
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-[12px] text-rose-300/90">
          {error}
        </p>
      )}
      <ul className="flex flex-wrap gap-2">
        {items.map((a) => (
          <li
            key={a.id}
            className="relative rounded-lg border border-white/8 bg-white/3 overflow-hidden flex items-center"
          >
            <AttachmentBody item={a} />
            <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 focus-within:opacity-100 hover:opacity-100 transition-opacity">
              {onEmbedMarkdown && (
                <IconButton
                  title="Embed in note body as markdown"
                  onClick={() => onEmbedMarkdown(markdownForAttachment(a))}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M4 6h16M4 12h10M4 18h16" />
                  </svg>
                </IconButton>
              )}
              <IconButton
                title="Reveal in Finder"
                onClick={() => void revealInFinder(a.file_path)}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3 7h6l2 2h10v10a2 2 0 0 1-2 2H3z" />
                </svg>
              </IconButton>
              <IconButton
                title="Remove attachment"
                tone="danger"
                onClick={() => void remove(a.id)}
                disabled={busy}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6" />
                </svg>
              </IconButton>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};

const AttachmentBody = ({ item }: { item: NoteAttachment }) => {
  const url = convertFileSrc(item.file_path);
  const kind = kindOf(item);
  switch (kind) {
    case 'image':
      return (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center"
          title={item.original_name}
        >
          <img
            src={url}
            alt={item.original_name}
            className="h-24 w-auto max-w-[220px] object-cover block"
            loading="lazy"
          />
        </a>
      );
    case 'video':
      return (
        <video
          src={url}
          controls
          preload="metadata"
          className="h-24 w-[220px] bg-black"
        >
          <track kind="captions" />
        </video>
      );
    case 'audio':
      return (
        <div className="px-3 py-2 min-w-[260px] flex flex-col gap-1">
          <AudioPlayer src={item.file_path} caption={item.original_name} />
          <div className="text-[10px] text-white/40 font-mono tabular-nums">
            {formatBytes(item.size_bytes)}
          </div>
        </div>
      );
    case 'file':
    default:
      return (
        <div className="px-3 py-2.5 flex items-center gap-2 min-w-[220px]">
          <div
            className="w-8 h-8 rounded-md flex items-center justify-center shrink-0"
            style={{
              backgroundColor: 'rgba(var(--stash-accent-rgb), 0.10)',
              color: 'rgb(var(--stash-accent-rgb))',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-medium text-white/90 truncate max-w-[160px]">
              {basename(item.original_name) || basename(item.file_path)}
            </div>
            <div className="text-[10px] text-white/45 font-mono truncate">
              {item.mime_type ?? '—'} · {formatBytes(item.size_bytes)}
            </div>
          </div>
        </div>
      );
  }
};
