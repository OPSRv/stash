import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listItems, searchItems, togglePin, deleteItem, pasteItem } from './api';

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
});
