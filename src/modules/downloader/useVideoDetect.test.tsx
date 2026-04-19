import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    detect: vi.fn(),
    detectQuick: vi.fn(),
  };
});

import { detect, detectQuick, type DetectedVideo, type QuickDetect } from './api';
import { useVideoDetect } from './useVideoDetect';

const fakeDetected: DetectedVideo = {
  platform: 'youtube',
  info: {
    id: 'abc',
    title: 'T',
    uploader: 'U',
    thumbnail: null,
    duration: 42,
    webpage_url: null,
    formats: [],
  },
  qualities: [],
};
const fakeQuick: QuickDetect = {
  platform: 'youtube',
  preview: { title: 'T', uploader: 'U', thumbnail: null },
};

describe('useVideoDetect', () => {
  beforeEach(() => {
    vi.mocked(detect).mockReset();
    vi.mocked(detectQuick).mockReset();
  });

  it('starts in the idle state', () => {
    const { result } = renderHook(() => useVideoDetect());
    expect(result.current.detecting).toBe(false);
    expect(result.current.detected).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.quick).toBeNull();
  });

  it('run() with empty string is a no-op', async () => {
    vi.mocked(detect).mockResolvedValue(fakeDetected);
    vi.mocked(detectQuick).mockResolvedValue(fakeQuick);
    const { result } = renderHook(() => useVideoDetect());
    await act(async () => {
      await result.current.run('   ');
    });
    expect(detect).not.toHaveBeenCalled();
    expect(result.current.detecting).toBe(false);
  });

  it('surfaces quick preview and full detection', async () => {
    vi.mocked(detectQuick).mockResolvedValue(fakeQuick);
    vi.mocked(detect).mockResolvedValue(fakeDetected);
    const { result } = renderHook(() => useVideoDetect());
    await act(async () => {
      await result.current.run('https://youtu.be/abc');
    });
    expect(result.current.detected).toEqual(fakeDetected);
    expect(result.current.detecting).toBe(false);
    await waitFor(() => expect(result.current.quick).toEqual(fakeQuick));
  });

  it('sets error when detect throws', async () => {
    vi.mocked(detectQuick).mockRejectedValue(new Error('quick fail'));
    vi.mocked(detect).mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useVideoDetect());
    await act(async () => {
      await result.current.run('https://youtu.be/abc');
    });
    expect(result.current.error).toContain('boom');
    expect(result.current.detected).toBeNull();
  });

  it('reset() clears state and advances the epoch so stale responses are ignored', async () => {
    let resolve: (v: DetectedVideo) => void = () => {};
    vi.mocked(detect).mockImplementation(
      () => new Promise<DetectedVideo>((r) => (resolve = r))
    );
    vi.mocked(detectQuick).mockResolvedValue(null);
    const { result } = renderHook(() => useVideoDetect());
    act(() => {
      void result.current.run('https://youtu.be/abc');
    });
    expect(result.current.detecting).toBe(true);
    act(() => result.current.reset());
    expect(result.current.detecting).toBe(false);
    await act(async () => {
      resolve(fakeDetected);
      // Flush microtasks.
      await Promise.resolve();
    });
    // Stale resolution must not populate detected after reset().
    expect(result.current.detected).toBeNull();
  });

  it('cancel() flags state as Cancelled', async () => {
    vi.mocked(detect).mockImplementation(
      () => new Promise<DetectedVideo>(() => {})
    );
    vi.mocked(detectQuick).mockResolvedValue(null);
    const { result } = renderHook(() => useVideoDetect());
    act(() => {
      void result.current.run('https://youtu.be/abc');
    });
    act(() => result.current.cancel());
    expect(result.current.error).toBe('Cancelled');
    expect(result.current.detecting).toBe(false);
  });
});
