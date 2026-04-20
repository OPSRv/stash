import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAudioPath, useAudioFileDrop } from './useAudioFileDrop';

type DragDropPayload =
  | { type: 'enter'; paths: string[]; position: { x: number; y: number } }
  | { type: 'over'; position: { x: number; y: number } }
  | { type: 'drop'; paths: string[]; position: { x: number; y: number } }
  | { type: 'leave' };

type Handler = (event: { payload: DragDropPayload }) => void;

let registered: Handler | null = null;
const unlisten = vi.fn();
const onDragDropEvent = vi.fn(async (h: Handler) => {
  registered = h;
  return unlisten;
});

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent }),
}));

const fire = (payload: DragDropPayload) => {
  if (!registered) throw new Error('no handler registered');
  registered({ payload });
};

beforeEach(() => {
  registered = null;
  onDragDropEvent.mockClear();
  unlisten.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('isAudioPath', () => {
  it('accepts common audio extensions regardless of case', () => {
    expect(isAudioPath('/x/y/song.mp3')).toBe(true);
    expect(isAudioPath('/x/y/song.MP3')).toBe(true);
    expect(isAudioPath('C:\\music\\a.M4A')).toBe(true);
    expect(isAudioPath('demo.wav')).toBe(true);
    expect(isAudioPath('rec.ogg')).toBe(true);
  });

  it('rejects non-audio and extension-less paths', () => {
    expect(isAudioPath('/x/cover.png')).toBe(false);
    expect(isAudioPath('/x/notes.md')).toBe(false);
    expect(isAudioPath('/x/no-extension')).toBe(false);
    expect(isAudioPath('/x/.hiddenfile')).toBe(false);
  });
});

describe('useAudioFileDrop', () => {
  it('tracks drag state when audio paths enter and leave', async () => {
    const onDrop = vi.fn();
    const { result, unmount } = renderHook(() => useAudioFileDrop(onDrop));
    // Wait a microtask for the async subscribe to register.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() =>
      fire({
        type: 'enter',
        paths: ['/x/song.mp3', '/x/cover.png', '/x/b.wav'],
        position: { x: 0, y: 0 },
      })
    );
    expect(result.current.isDragOver).toBe(true);
    expect(result.current.audioCount).toBe(2);

    act(() => fire({ type: 'leave' }));
    expect(result.current.isDragOver).toBe(false);
    expect(result.current.audioCount).toBe(0);

    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('stays hidden when the drag carries no audio files', async () => {
    const onDrop = vi.fn();
    const { result } = renderHook(() => useAudioFileDrop(onDrop));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() =>
      fire({
        type: 'enter',
        paths: ['/x/photo.jpg', '/x/doc.pdf'],
        position: { x: 0, y: 0 },
      })
    );
    expect(result.current.isDragOver).toBe(false);
    expect(result.current.audioCount).toBe(0);
  });

  it('passes only audio paths to onDrop and resets state', async () => {
    const onDrop = vi.fn();
    const { result } = renderHook(() => useAudioFileDrop(onDrop));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() =>
      fire({
        type: 'drop',
        paths: ['/x/a.mp3', '/x/cover.png', '/x/b.m4a'],
        position: { x: 0, y: 0 },
      })
    );

    expect(onDrop).toHaveBeenCalledWith(['/x/a.mp3', '/x/b.m4a']);
    expect(result.current.isDragOver).toBe(false);
  });

  it('does not fire onDrop when the drop contains no audio', async () => {
    const onDrop = vi.fn();
    renderHook(() => useAudioFileDrop(onDrop));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() =>
      fire({ type: 'drop', paths: ['/x/only.pdf'], position: { x: 0, y: 0 } })
    );

    expect(onDrop).not.toHaveBeenCalled();
  });
});
