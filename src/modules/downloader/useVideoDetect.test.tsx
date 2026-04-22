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

  it('starts with an empty session list', () => {
    const { result } = renderHook(() => useVideoDetect());
    expect(result.current.sessions).toEqual([]);
    expect(result.current.detecting).toBe(false);
  });

  it('run() with empty string is a no-op', () => {
    vi.mocked(detect).mockResolvedValue(fakeDetected);
    vi.mocked(detectQuick).mockResolvedValue(fakeQuick);
    const { result } = renderHook(() => useVideoDetect());
    act(() => {
      result.current.run('   ');
    });
    expect(detect).not.toHaveBeenCalled();
    expect(result.current.sessions).toEqual([]);
  });

  it('surfaces quick preview and full detection for a session', async () => {
    vi.mocked(detectQuick).mockResolvedValue(fakeQuick);
    vi.mocked(detect).mockResolvedValue(fakeDetected);
    const { result } = renderHook(() => useVideoDetect());
    act(() => {
      result.current.run('https://youtu.be/abc');
    });
    await waitFor(() => {
      const s = result.current.sessions[0];
      expect(s?.detected).toEqual(fakeDetected);
      expect(s?.detecting).toBe(false);
    });
    await waitFor(() => {
      expect(result.current.sessions[0]?.quick).toEqual(fakeQuick);
    });
  });

  it('sets the session error when detect throws', async () => {
    vi.mocked(detectQuick).mockRejectedValue(new Error('quick fail'));
    vi.mocked(detect).mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useVideoDetect());
    act(() => {
      result.current.run('https://youtu.be/abc');
    });
    await waitFor(() => {
      const s = result.current.sessions[0];
      expect(s?.error).toContain('boom');
      expect(s?.detected).toBeNull();
    });
  });

  it('stacks multiple sessions when run() is called in sequence', async () => {
    let n = 0;
    vi.mocked(detect).mockImplementation(() => {
      n += 1;
      return Promise.resolve({ ...fakeDetected, info: { ...fakeDetected.info, title: `T${n}` } });
    });
    vi.mocked(detectQuick).mockResolvedValue(null);
    const { result } = renderHook(() => useVideoDetect());
    act(() => {
      result.current.run('https://youtu.be/a');
      result.current.run('https://youtu.be/b');
      result.current.run('https://youtu.be/c');
    });
    expect(result.current.sessions).toHaveLength(3);
    expect(result.current.sessions.map((s) => s.url)).toEqual([
      'https://youtu.be/a',
      'https://youtu.be/b',
      'https://youtu.be/c',
    ]);
  });

  it('dismiss() removes a session and swallows any late response for it', async () => {
    let resolve: (v: DetectedVideo) => void = () => {};
    vi.mocked(detect).mockImplementation(
      () => new Promise<DetectedVideo>((r) => (resolve = r))
    );
    vi.mocked(detectQuick).mockResolvedValue(null);
    const { result } = renderHook(() => useVideoDetect());
    act(() => {
      result.current.run('https://youtu.be/abc');
    });
    const id = result.current.sessions[0]!.id;
    act(() => result.current.dismiss(id));
    expect(result.current.sessions).toEqual([]);
    await act(async () => {
      resolve(fakeDetected);
      await Promise.resolve();
    });
    expect(result.current.sessions).toEqual([]);
  });

  it('cancel() marks a session as Cancelled without removing it', () => {
    vi.mocked(detect).mockImplementation(
      () => new Promise<DetectedVideo>(() => {})
    );
    vi.mocked(detectQuick).mockResolvedValue(null);
    const { result } = renderHook(() => useVideoDetect());
    act(() => {
      result.current.run('https://youtu.be/abc');
    });
    const id = result.current.sessions[0]!.id;
    act(() => result.current.cancel(id));
    const s = result.current.sessions[0]!;
    expect(s.error).toBe('Cancelled');
    expect(s.detecting).toBe(false);
  });

  it('run() is a no-op when a live session already exists for that exact URL', () => {
    vi.mocked(detect).mockImplementation(() => new Promise(() => {}));
    vi.mocked(detectQuick).mockResolvedValue(null);
    const { result } = renderHook(() => useVideoDetect());
    act(() => {
      result.current.run('https://youtu.be/abc');
    });
    expect(result.current.sessions).toHaveLength(1);
    // Second identical call (e.g. StrictMode re-invoke) must not stack.
    act(() => {
      result.current.run('https://youtu.be/abc');
    });
    expect(result.current.sessions).toHaveLength(1);
    // A DIFFERENT URL still opens its own session.
    act(() => {
      result.current.run('https://youtu.be/xyz');
    });
    expect(result.current.sessions).toHaveLength(2);
    // detect was called exactly twice total, not three times — dedup
    // fires BEFORE the API invoke so no wasted work.
    expect(vi.mocked(detect)).toHaveBeenCalledTimes(2);
  });

  it('clearAll() drops every queued session', () => {
    vi.mocked(detect).mockImplementation(() => new Promise(() => {}));
    vi.mocked(detectQuick).mockResolvedValue(null);
    const { result } = renderHook(() => useVideoDetect());
    act(() => {
      result.current.run('https://youtu.be/a');
      result.current.run('https://youtu.be/b');
    });
    expect(result.current.sessions).toHaveLength(2);
    act(() => result.current.clearAll());
    expect(result.current.sessions).toEqual([]);
  });
});
