import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';
import * as events from '@tauri-apps/api/event';
const __emit = (events as unknown as { __emit: (e: string, p: unknown) => void }).__emit;

import { NoteAudioStrip } from './NoteAudioStrip';
import type { Note } from './api';

const mkNote = (over: Partial<Note> = {}): Note => ({
  id: 1,
  title: 'Test note',
  body: 'some body',
  created_at: 100,
  updated_at: 100,
  audio_path: '/app/notes/audio/1.m4a',
  audio_duration_ms: 30000,
  pinned: false,
  audio_transcription: null,
  ...over,
});

describe('<NoteAudioStrip />', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  it('renders nothing when audio_path is null', () => {
    const { container } = render(
      <NoteAudioStrip note={mkNote({ audio_path: null, audio_duration_ms: null })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows idle TranscriptArea (Транскрибувати button) when audio_transcription is null', async () => {
    render(<NoteAudioStrip note={mkNote({ audio_transcription: null })} />);
    expect(await screen.findByRole('button', { name: /транскрибувати/i })).toBeInTheDocument();
  });

  it('clicking Транскрибувати invokes notes_transcribe_note_audio with note id', async () => {
    const user = userEvent.setup();
    render(<NoteAudioStrip note={mkNote({ id: 7, audio_transcription: null })} />);
    const btn = await screen.findByRole('button', { name: /транскрибувати/i });
    await user.click(btn);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('notes_transcribe_note_audio', { noteId: 7 }),
    );
  });

  it('shows existing audio_transcription text', async () => {
    render(<NoteAudioStrip note={mkNote({ audio_transcription: 'Voice note transcript here' })} />);
    expect(await screen.findByText('Voice note transcript here')).toBeInTheDocument();
  });

  it('notes:note_updated event triggers onNoteUpdated callback and updates transcript', async () => {
    const onNoteUpdated = vi.fn();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'notes_get') return mkNote({ id: 3, audio_transcription: 'Fresh transcript' });
      return undefined;
    });
    render(
      <NoteAudioStrip note={mkNote({ id: 3, audio_transcription: null })} onNoteUpdated={onNoteUpdated} />,
    );
    await screen.findByRole('button', { name: /транскрибувати/i });

    __emit('notes:note_updated', { note_id: 3 });

    await waitFor(() => expect(onNoteUpdated).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Fresh transcript')).toBeInTheDocument();
  });

  it('edit saves via notes_set_audio_transcription', async () => {
    const user = userEvent.setup();
    render(<NoteAudioStrip note={mkNote({ id: 2, audio_transcription: 'Old text' })} />);

    // Click edit button (appears on hover — find by aria-label)
    const editBtn = await screen.findByRole('button', { name: /edit transcript/i });
    await user.click(editBtn);

    const textarea = screen.getByRole('textbox', { name: /edit transcript/i });
    await user.clear(textarea);
    await user.type(textarea, 'New text');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('notes_set_audio_transcription', {
        noteId: 2,
        transcription: 'New text',
      }),
    );
  });
});
