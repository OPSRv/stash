import { invoke } from '@tauri-apps/api/core';

export type ClipboardItem = {
  id: number;
  kind: 'text' | 'image';
  content: string;
  meta: string | null;
  created_at: number;
  pinned: boolean;
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
