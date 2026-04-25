import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';
import * as events from '@tauri-apps/api/event';
const __emit = (events as unknown as { __emit: (e: string, p: unknown) => void }).__emit;

import { NoteAttachmentsPanel } from './NoteAttachmentsPanel';
import type { NoteAttachment } from './api';

const mkAttachment = (over: Partial<NoteAttachment> = {}): NoteAttachment => ({
  id: 1,
  note_id: 10,
  file_path: '/app/data/notes/attachments/10/abc_report.pdf',
  original_name: 'report.pdf',
  mime_type: 'application/pdf',
  size_bytes: 2048,
  created_at: 1,
  transcription: null,
  ...over,
});

describe('<NoteAttachmentsPanel />', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('empty state shows the + Attach file prompt', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'notes_list_attachments') return [];
      return undefined;
    });
    render(<NoteAttachmentsPanel noteId={10} />);
    expect(
      await screen.findByRole('button', { name: /attach file/i }),
    ).toBeInTheDocument();
  });

  it('renders attachments and lets the user remove one', async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'notes_list_attachments')
        return [mkAttachment({ id: 7 })];
      if (cmd === 'notes_remove_attachment') return undefined;
      return undefined;
    });
    render(<NoteAttachmentsPanel noteId={10} />);
    await screen.findByText(/report.pdf/);
    await user.click(
      screen.getByRole('button', { name: /remove attachment/i }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('notes_remove_attachment', { id: 7 }),
    );
  });

  // ── Transcription (audio attachments) ─────────────────────────────────

  it('audio attachment: renders a TranscriptArea (idle) when transcription is null', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'notes_list_attachments')
        return [
          mkAttachment({
            id: 5,
            original_name: 'voice.mp3',
            mime_type: 'audio/mpeg',
            file_path: '/app/notes/5.mp3',
            transcription: null,
          }),
        ];
      return undefined;
    });
    render(<NoteAttachmentsPanel noteId={10} />);
    // TranscriptArea in idle state renders a "Транскрибувати" button
    expect(await screen.findByRole('button', { name: /транскрибувати/i })).toBeInTheDocument();
  });

  it('audio attachment: idle click invokes transcribeAttachment(id)', async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'notes_list_attachments')
        return [
          mkAttachment({
            id: 5,
            original_name: 'voice.mp3',
            mime_type: 'audio/mpeg',
            file_path: '/app/notes/5.mp3',
            transcription: null,
          }),
        ];
      if (cmd === 'notes_transcribe_attachment') return undefined;
      return undefined;
    });
    render(<NoteAttachmentsPanel noteId={10} />);
    const btn = await screen.findByRole('button', { name: /транскрибувати/i });
    await user.click(btn);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('notes_transcribe_attachment', { attachmentId: 5 }),
    );
  });

  it('audio attachment: shows existing transcription text', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'notes_list_attachments')
        return [
          mkAttachment({
            id: 6,
            original_name: 'voice.m4a',
            mime_type: 'audio/m4a',
            file_path: '/app/notes/6.m4a',
            transcription: 'Hello this is a test',
          }),
        ];
      return undefined;
    });
    render(<NoteAttachmentsPanel noteId={10} />);
    expect(await screen.findByText('Hello this is a test')).toBeInTheDocument();
  });

  it('non-audio attachment: does not render a TranscriptArea', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'notes_list_attachments')
        return [mkAttachment({ id: 9, mime_type: 'application/pdf' })];
      return undefined;
    });
    render(<NoteAttachmentsPanel noteId={10} />);
    // Default factory has original_name: 'report.pdf' — wait for render
    await screen.findByText(/report\.pdf/);
    // No Транскрибувати button for non-audio attachments
    expect(screen.queryByRole('button', { name: /транскрибувати/i })).not.toBeInTheDocument();
  });

  it('audio attachment: attachment_updated event triggers list refresh with updated transcription', async () => {
    let callCount = 0;
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'notes_list_attachments') {
        callCount += 1;
        if (callCount === 1) {
          return [
            mkAttachment({
              id: 5,
              original_name: 'voice.mp3',
              mime_type: 'audio/mpeg',
              transcription: null,
            }),
          ];
        }
        return [
          mkAttachment({
            id: 5,
            original_name: 'voice.mp3',
            mime_type: 'audio/mpeg',
            transcription: 'Updated transcript',
          }),
        ];
      }
      return undefined;
    });
    render(<NoteAttachmentsPanel noteId={10} />);
    await screen.findByRole('button', { name: /транскрибувати/i });

    // Simulate backend event
    __emit('notes:attachment_updated', { id: 5 });

    expect(await screen.findByText('Updated transcript')).toBeInTheDocument();
  });

  it('renders an inline <img> for image attachments', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'notes_list_attachments')
        return [
          mkAttachment({
            id: 8,
            original_name: 'cat.png',
            mime_type: 'image/png',
            file_path: '/app/notes/8.png',
          }),
        ];
      return undefined;
    });
    render(<NoteAttachmentsPanel noteId={10} />);
    const img = await screen.findByAltText('cat.png');
    expect(img).toBeInstanceOf(HTMLImageElement);
    expect(img.getAttribute('src')).toContain('asset://localhost');
  });
});
