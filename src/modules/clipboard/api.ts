import { invoke } from '@tauri-apps/api/core';

export type ClipboardItem = {
  id: number;
  content: string;
  created_at: number;
  pinned: boolean;
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
