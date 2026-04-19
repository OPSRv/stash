import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  listItems,
  searchItems,
  togglePin,
  deleteItem,
  pasteItem,
  copyOnly,
  clearAll,
  linkPreview,
} from './api';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

const fixture = [
  { id: 1, content: 'hello', created_at: 100, pinned: false },
  { id: 2, content: 'world', created_at: 200, pinned: true },
];

describe('clipboard api', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  describe('listItems', () => {
    it('calls clipboard_list and returns items', async () => {
      mockInvoke.mockResolvedValueOnce(fixture);
      const result = await listItems();
      expect(mockInvoke).toHaveBeenCalledWith('clipboard_list');
      expect(result).toEqual(fixture);
    });
  });

  describe('searchItems', () => {
    it('calls clipboard_search with trimmed query', async () => {
      mockInvoke.mockResolvedValueOnce([fixture[0]]);
      const result = await searchItems('  hello  ');
      expect(mockInvoke).toHaveBeenCalledWith('clipboard_search', { query: 'hello' });
      expect(result).toHaveLength(1);
    });
  });

  describe('togglePin', () => {
    it('calls clipboard_toggle_pin with id', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);
      await togglePin(42);
      expect(mockInvoke).toHaveBeenCalledWith('clipboard_toggle_pin', { id: 42 });
    });
  });

  describe('deleteItem', () => {
    it('calls clipboard_delete with id', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);
      await deleteItem(7);
      expect(mockInvoke).toHaveBeenCalledWith('clipboard_delete', { id: 7 });
    });
  });

  describe('pasteItem', () => {
    it('calls clipboard_paste with id', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);
      await pasteItem(9);
      expect(mockInvoke).toHaveBeenCalledWith('clipboard_paste', { id: 9 });
    });
  });

  describe('copyOnly', () => {
    it('calls clipboard_copy_only with id', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);
      await copyOnly(12);
      expect(mockInvoke).toHaveBeenCalledWith('clipboard_copy_only', { id: 12 });
    });
  });

  describe('clearAll', () => {
    it('calls clipboard_clear and returns removed count', async () => {
      mockInvoke.mockResolvedValueOnce(5);
      const removed = await clearAll();
      expect(mockInvoke).toHaveBeenCalledWith('clipboard_clear');
      expect(removed).toBe(5);
    });
  });

  describe('linkPreview', () => {
    it('forwards the URL to clipboard_link_preview', async () => {
      mockInvoke.mockResolvedValueOnce({
        url: 'https://example.com',
        image: 'https://cdn/og.png',
        title: 'Hi',
        description: null,
        site_name: null,
      });
      const p = await linkPreview('https://example.com');
      expect(mockInvoke).toHaveBeenCalledWith('clipboard_link_preview', {
        url: 'https://example.com',
      });
      expect(p?.image).toBe('https://cdn/og.png');
    });

    it('resolves to null when backend reports no metadata', async () => {
      mockInvoke.mockResolvedValueOnce(null);
      const p = await linkPreview('https://blank.example');
      expect(p).toBeNull();
    });
  });
});
