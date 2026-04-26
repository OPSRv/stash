import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  notesCreate,
  notesDelete,
  notesList,
  notesImageStreamUrl,
  notesReadAudioByPath,
  notesSaveAudioBytes,
  notesSaveAudioFile,
  notesSearch,
  notesSetAttachmentTranscription,
  notesSetAudioTranscription,
  notesTranscribeAttachment,
  notesTranscribeNoteAudio,
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

  it('notesImageStreamUrl returns the resolved loopback url', async () => {
    vi.mocked(invoke).mockResolvedValue(
      'http://127.0.0.1:51234/image?path=%2Fmanaged%2Fa.png&t=tok' as never,
    );
    const url = await notesImageStreamUrl('/managed/a.png');
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/image\?/);
    expect(invoke).toHaveBeenCalledWith('notes_image_stream_url', { path: '/managed/a.png' });
  });

  it('notesSetAudioTranscription forwards noteId and transcription text', async () => {
    await notesSetAudioTranscription(42, 'hello world');
    expect(invoke).toHaveBeenCalledWith('notes_set_audio_transcription', {
      noteId: 42,
      transcription: 'hello world',
    });
  });

  it('notesSetAudioTranscription forwards null to clear', async () => {
    await notesSetAudioTranscription(42, null);
    expect(invoke).toHaveBeenCalledWith('notes_set_audio_transcription', {
      noteId: 42,
      transcription: null,
    });
  });

  it('notesSetAttachmentTranscription forwards id and transcription text', async () => {
    await notesSetAttachmentTranscription(7, 'attachment text');
    expect(invoke).toHaveBeenCalledWith('notes_set_attachment_transcription', {
      id: 7,
      transcription: 'attachment text',
    });
  });

  it('notesSetAttachmentTranscription forwards null to clear', async () => {
    await notesSetAttachmentTranscription(7, null);
    expect(invoke).toHaveBeenCalledWith('notes_set_attachment_transcription', {
      id: 7,
      transcription: null,
    });
  });

  it('notesTranscribeNoteAudio forwards noteId', async () => {
    await notesTranscribeNoteAudio(12);
    expect(invoke).toHaveBeenCalledWith('notes_transcribe_note_audio', { noteId: 12 });
  });

  it('notesTranscribeAttachment forwards attachmentId', async () => {
    await notesTranscribeAttachment(99);
    expect(invoke).toHaveBeenCalledWith('notes_transcribe_attachment', { attachmentId: 99 });
  });
});
