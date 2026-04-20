import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  notesCreate,
  notesDelete,
  notesList,
  notesReadAudioByPath,
  notesSaveAudioBytes,
  notesSaveAudioFile,
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

  it('notesSaveAudioBytes forwards bytes + extension and returns the saved path', async () => {
    vi.mocked(invoke).mockResolvedValue('/abs/saved.mp4' as never);
    const bytes = new Uint8Array([1, 2, 3]);
    const path = await notesSaveAudioBytes(bytes, 'mp4');
    expect(path).toBe('/abs/saved.mp4');
    expect(invoke).toHaveBeenCalledWith('notes_save_audio_bytes', {
      bytes: [1, 2, 3],
      ext: 'mp4',
    });
  });

  it('notesSaveAudioFile forwards the source path and returns the copy path', async () => {
    vi.mocked(invoke).mockResolvedValue('/managed/copied.wav' as never);
    const p = await notesSaveAudioFile('/home/user/rec.wav');
    expect(p).toBe('/managed/copied.wav');
    expect(invoke).toHaveBeenCalledWith('notes_save_audio_file', { path: '/home/user/rec.wav' });
  });

  it('notesReadAudioByPath unwraps the number[] payload into a Uint8Array', async () => {
    vi.mocked(invoke).mockResolvedValue([10, 20, 30] as never);
    const bytes = await notesReadAudioByPath('/managed/rec.mp4');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual([10, 20, 30]);
    expect(invoke).toHaveBeenCalledWith('notes_read_audio_path', { path: '/managed/rec.mp4' });
  });
});
