import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioNoteView } from './AudioNoteView';
import { DEFAULT_SETTINGS } from '../../settings/store';
import type { Note } from './api';

vi.mock('./api', async (orig) => {
  const actual = await orig<typeof import('./api')>();
  return {
    ...actual,
    notesReadAudio: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  };
});

const loadSettingsMock = vi.hoisted(() => vi.fn());
vi.mock('../../settings/store', async (orig) => {
  const actual = await orig<typeof import('../../settings/store')>();
  return {
    ...actual,
    loadSettings: loadSettingsMock,
  };
});

const audioNote = (overrides: Partial<Note> = {}): Note => ({
  id: 1,
  title: 'Voice',
  body: '',
  created_at: 0,
  updated_at: 0,
  audio_path: '/tmp/1.webm',
  audio_duration_ms: 32_000,
  pinned: false,
  ...overrides,
});

const createObjectURL = vi.fn(() => 'blob:mock');
const revokeObjectURL = vi.fn();

beforeAll(() => {
  (URL as unknown as { createObjectURL: typeof createObjectURL }).createObjectURL = createObjectURL;
  (URL as unknown as { revokeObjectURL: typeof revokeObjectURL }).revokeObjectURL = revokeObjectURL;
  loadSettingsMock.mockResolvedValue({
    ...DEFAULT_SETTINGS,
    notesAutoTranscribe: true,
    notesAutoPolish: true,
  });
});

afterEach(() => {
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  loadSettingsMock.mockReset();
  // Default: both auto flags ON (production default) — manual buttons hide.
  loadSettingsMock.mockResolvedValue({
    ...DEFAULT_SETTINGS,
    notesAutoTranscribe: true,
    notesAutoPolish: true,
  });
});

describe('AudioNoteView', () => {
  it('renders a play control, a waveform, and duration seeded from the note', async () => {
    render(<AudioNoteView note={audioNote()} />);
    expect(screen.getByTestId('audio-note-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('audio-note-waveform')).toBeInTheDocument();
    expect(screen.getByText(/0:00 \/ 0:32/)).toBeInTheDocument();
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
  });

  it('shows an empty-state message for notes without a transcript', () => {
    render(<AudioNoteView note={audioNote()} />);
    expect(screen.getByText(/No transcript yet/i)).toBeInTheDocument();
  });

  it('renders the transcript body when present', () => {
    render(<AudioNoteView note={audioNote({ body: 'Hello world' })} />);
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('hides Transcribe / Polish buttons when auto flags are on (defaults)', async () => {
    render(<AudioNoteView note={audioNote({ body: 'prior transcript' })} />);
    // Let the settings effect flush — both manual buttons should disappear.
    await waitFor(() => {
      expect(screen.queryByTestId('audio-transcribe')).not.toBeInTheDocument();
      expect(screen.queryByTestId('audio-polish')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('audio-clear-transcript')).toBeEnabled();
  });

  it('shows Transcribe + Polish when auto flags are off', async () => {
    loadSettingsMock.mockReset();
    loadSettingsMock.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      notesAutoTranscribe: false,
      notesAutoPolish: false,
    });
    render(<AudioNoteView note={audioNote({ body: 'prior transcript' })} />);
    await waitFor(() => {
      expect(screen.getByTestId('audio-transcribe')).toBeInTheDocument();
      expect(screen.getByTestId('audio-polish')).toBeInTheDocument();
    });
  });

  it('disables Clear transcript when there is nothing to clear', () => {
    render(<AudioNoteView note={audioNote()} />);
    expect(screen.getByTestId('audio-clear-transcript')).toBeDisabled();
  });
});
