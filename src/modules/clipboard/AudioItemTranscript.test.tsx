import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ClipboardPopup } from './ClipboardPopup';
import { isSingleAudioItem } from './AudioItemTranscript';
import type { ClipboardItem } from './api';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));
const mockInvoke = vi.mocked(invoke);

// Base item factory.
const makeItem = (overrides: Partial<ClipboardItem> = {}): ClipboardItem => ({
  id: 1,
  kind: 'file',
  content: 'files:abc',
  meta: null,
  created_at: 100,
  pinned: false,
  transcription: null,
  ...overrides,
});

const audioMeta = JSON.stringify({
  files: [{ path: '/tmp/voice.mp3', name: 'voice.mp3', size: 8000, mime: 'audio/mpeg' }],
});

const imageMeta = JSON.stringify({
  files: [{ path: '/tmp/photo.png', name: 'photo.png', size: 4000, mime: 'image/png' }],
});

const multiFileMeta = JSON.stringify({
  files: [
    { path: '/tmp/voice.mp3', name: 'voice.mp3', size: 8000, mime: 'audio/mpeg' },
    { path: '/tmp/doc.pdf', name: 'doc.pdf', size: 2000, mime: 'application/pdf' },
  ],
});

describe('isSingleAudioItem', () => {
  it('returns true for a single-audio-file item', () => {
    const item = makeItem({ meta: audioMeta });
    expect(isSingleAudioItem(item)).toBe(true);
  });

  it('returns false for a text item', () => {
    expect(isSingleAudioItem(makeItem({ kind: 'text', meta: null }))).toBe(false);
  });

  it('returns false for a single image file', () => {
    expect(isSingleAudioItem(makeItem({ meta: imageMeta }))).toBe(false);
  });

  it('returns false for multi-file items even when first is audio', () => {
    expect(isSingleAudioItem(makeItem({ meta: multiFileMeta }))).toBe(false);
  });

  it('detects audio by extension (m4a) even without mime', () => {
    const meta = JSON.stringify({
      files: [{ path: '/tmp/rec.m4a', name: 'rec.m4a', size: null, mime: null }],
    });
    expect(isSingleAudioItem(makeItem({ meta }))).toBe(true);
  });

  it('returns false when meta is null', () => {
    expect(isSingleAudioItem(makeItem({ meta: null }))).toBe(false);
  });
});

describe('ClipboardPopup — audio transcription UI', () => {
  const audioItem: ClipboardItem = {
    id: 42,
    kind: 'file',
    content: 'files:audio1',
    meta: audioMeta,
    created_at: 500,
    pinned: false,
    transcription: null,
  };

  const textItem: ClipboardItem = {
    id: 10,
    kind: 'text',
    content: 'hello world',
    meta: null,
    created_at: 400,
    pinned: false,
    transcription: null,
  };

  const imageItem: ClipboardItem = {
    id: 11,
    kind: 'file',
    content: 'files:img',
    meta: imageMeta,
    created_at: 300,
    pinned: false,
    transcription: null,
  };

  const multiFileItem: ClipboardItem = {
    id: 12,
    kind: 'file',
    content: 'files:multi',
    meta: multiFileMeta,
    created_at: 200,
    pinned: false,
    transcription: null,
  };

  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'clipboard_list')
        return [audioItem, textItem, imageItem, multiFileItem];
      if (cmd === 'clipboard_search') return [];
      return undefined;
    });
  });

  it('renders TranscriptArea (Transcribe button) for an audio-only item', async () => {
    render(<ClipboardPopup />);
    // The TranscriptArea idle state renders a "Транскрибувати" button.
    expect(await screen.findByText('Транскрибувати')).toBeInTheDocument();
  });

  it('does NOT render TranscriptArea for a plain text item', async () => {
    render(<ClipboardPopup />);
    await screen.findByText('hello world');
    // Only one Transcribe button — for the audio row.
    const buttons = screen.queryAllByText('Транскрибувати');
    // Must be exactly 1 (for the audio row), not > 1.
    expect(buttons.length).toBe(1);
  });

  it('does NOT render TranscriptArea for an image file item', async () => {
    // Remove audio item so only image is visible.
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'clipboard_list') return [imageItem];
      return undefined;
    });
    render(<ClipboardPopup />);
    await screen.findByText('photo.png');
    expect(screen.queryByText('Транскрибувати')).toBeNull();
  });

  it('does NOT render TranscriptArea for a multi-file item', async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'clipboard_list') return [multiFileItem];
      return undefined;
    });
    render(<ClipboardPopup />);
    await screen.findByText('voice.mp3');
    expect(screen.queryByText('Транскрибувати')).toBeNull();
  });

  it('clicking Transcribe calls clipboard_transcribe_item with the audio item id', async () => {
    const user = userEvent.setup();
    render(<ClipboardPopup />);
    const transcribeBtn = await screen.findByText('Транскрибувати');
    await user.click(transcribeBtn);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('clipboard_transcribe_item', { id: 42 });
    });
  });

  it('shows existing transcription text for an audio item that already has one', async () => {
    const withTranscript: ClipboardItem = {
      ...audioItem,
      transcription: 'Hello from Whisper',
    };
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'clipboard_list') return [withTranscript];
      return undefined;
    });
    render(<ClipboardPopup />);
    expect(await screen.findByText('Hello from Whisper')).toBeInTheDocument();
  });
});
