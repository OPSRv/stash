import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  notesCreate,
  notesCreateAudio,
  notesDelete,
  notesList,
  notesReadAudio,
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

  it('notesCreateAudio forwards a byte array, extension and duration', async () => {
    vi.mocked(invoke).mockResolvedValue({
      id: 9,
      title: 'Voice',
      body: '',
      created_at: 0,
      updated_at: 0,
      audio_path: '/tmp/9.webm',
      audio_duration_ms: 1500,
      pinned: false,
    } as never);
    const bytes = new Uint8Array([1, 2, 3]);
    const note = await notesCreateAudio({ title: 'Voice', bytes, ext: 'webm', durationMs: 1500 });
    expect(note.id).toBe(9);
    expect(invoke).toHaveBeenCalledWith('notes_create_audio', {
      title: 'Voice',
      bytes: [1, 2, 3],
      ext: 'webm',
      durationMs: 1500,
    });
  });

  it('notesReadAudio unwraps the number[] payload into a Uint8Array', async () => {
    vi.mocked(invoke).mockResolvedValue([10, 20, 30] as never);
    const bytes = await notesReadAudio(4);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual([10, 20, 30]);
    expect(invoke).toHaveBeenCalledWith('notes_read_audio', { id: 4 });
  });
});
