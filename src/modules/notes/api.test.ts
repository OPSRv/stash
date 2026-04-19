import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  notesCreate,
  notesDelete,
  notesList,
  notesSearch,
  notesUpdate,
} from './api';

describe('notes/api', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined as never);
  });

  it('notesList is argument-less', async () => {
    await notesList();
    expect(invoke).toHaveBeenCalledWith('notes_list');
  });

  it('notesSearch forwards query', async () => {
    await notesSearch('hello');
    expect(invoke).toHaveBeenCalledWith('notes_search', { query: 'hello' });
  });

  it('notesCreate forwards title/body', async () => {
    vi.mocked(invoke).mockResolvedValue(7 as never);
    const id = await notesCreate('t', 'b');
    expect(id).toBe(7);
    expect(invoke).toHaveBeenCalledWith('notes_create', { title: 't', body: 'b' });
  });

  it('notesUpdate forwards id/title/body', async () => {
    await notesUpdate(3, 't2', 'b2');
    expect(invoke).toHaveBeenCalledWith('notes_update', { id: 3, title: 't2', body: 'b2' });
  });

  it('notesDelete forwards id', async () => {
    await notesDelete(5);
    expect(invoke).toHaveBeenCalledWith('notes_delete', { id: 5 });
  });
});
