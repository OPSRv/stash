import { invoke } from '@tauri-apps/api/core';

/// `file` is produced by the Rust clipboard monitor when Finder puts
/// one or more `public.file-url` entries on the pasteboard. `meta` for
/// these rows carries the full payload (see `FileMeta`) — `content`
/// is an opaque stable dedupe key (`files:<sha256>`) and should not be
/// rendered to users.
export type ClipboardItem = {
  id: number;
  kind: 'text' | 'image' | 'file';
  content: string;
  meta: string | null;
  created_at: number;
  pinned: boolean;
  /** Whisper transcription — only populated for single-audio-file items. */
  transcription: string | null;
};

export type ImageMeta = {
  path: string;
  w: number;
  h: number;
};

export const parseImageMeta = (item: ClipboardItem): ImageMeta | null => {
  if (item.kind !== 'image' || !item.meta) return null;
  try {
    return JSON.parse(item.meta) as ImageMeta;
  } catch {
    return null;
  }
};

/// Per-entry shape inside a `kind = 'file'` clipboard row. Mirrors the
/// Rust `FileEntry` struct in `monitor.rs`. `size` and `mime` are
/// best-effort — missing size means the file was inaccessible at
/// monitor time; missing mime means no extension match.
export type FileEntry = {
  path: string;
  name: string;
  size: number | null;
  mime: string | null;
};

export type FileMeta = {
  files: FileEntry[];
};

export const parseFileMeta = (item: ClipboardItem): FileMeta | null => {
  if (item.kind !== 'file' || !item.meta) return null;
  try {
    const parsed = JSON.parse(item.meta) as Partial<FileMeta>;
    if (!parsed || !Array.isArray(parsed.files)) return null;
    return { files: parsed.files };
  } catch {
    return null;
  }
};

export const listItems = (): Promise<ClipboardItem[]> => invoke('clipboard_list');

export const searchItems = (query: string): Promise<ClipboardItem[]> =>
  invoke('clipboard_search', { query: query.trim() });

export const togglePin = (id: number): Promise<void> =>
  invoke('clipboard_toggle_pin', { id });

export const deleteItem = (id: number): Promise<void> =>
  invoke('clipboard_delete', { id });

export const pasteItem = (id: number): Promise<void> =>
  invoke('clipboard_paste', { id });

export const copyOnly = (id: number): Promise<void> =>
  invoke('clipboard_copy_only', { id });

export const clearAll = (): Promise<number> => invoke('clipboard_clear');

/// Ask the backend to drop any `kind='file'` rows whose paths no
/// longer exist or were never user-visible (WebKit promise drops,
/// already-purged caches, etc.). Resolves to the number of rows that
/// were removed. Safe to call any time — backend treats it as a
/// best-effort sweep.
export const pruneFiles = (): Promise<number> => invoke('clipboard_prune_files');

/** Overwrite (or clear) the stored transcription for a clipboard item.
 *  Pass `null` to clear. Emits `clipboard:item_updated` on success. */
export const setTranscription = (id: number, transcription: string | null): Promise<void> =>
  invoke('clipboard_set_transcription', { id, transcription });

/** Ask the backend to run Whisper on the single audio file in this item.
 *  Returns immediately — progress is delivered via events:
 *  - `clipboard:transcribing`      `id`           — job started
 *  - `clipboard:item_updated`      `id`           — transcription saved
 *  - `clipboard:transcribe_failed` `{id, error}`  — Whisper failed */
export const transcribeItem = (id: number): Promise<void> =>
  invoke('clipboard_transcribe_item', { id });

export type LinkPreview = {
  url: string;
  image: string | null;
  title: string | null;
  description: string | null;
  site_name: string | null;
};

/// Fetch og:image / og:title for a URL. Returns null when the page has no
/// usable metadata. The Rust side caches both hits and misses.
export const linkPreview = (url: string): Promise<LinkPreview | null> =>
  invoke('clipboard_link_preview', { url });
