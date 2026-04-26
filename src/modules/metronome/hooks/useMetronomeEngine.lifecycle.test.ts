import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMetronomeEngine } from './useMetronomeEngine';

const cfg = {
  bpm: 120,
  subdivision: 1 as const,
  numerator: 4,
  sound: 'classic',
  click_volume: 1,
  accent_volume: 1,
  beat_accents: [true, false, false, false],
};

/// Smoke-coverage for the visibilitychange handler that re-resumes the
/// AudioContext when the popup tab becomes visible again. The full audio
/// graph (oscillators, gain, scheduler worker) is mocked — we only care
/// that `ctx.resume()` is called on `visibilitychange → visible` while
/// `isPlaying` is true, and *not* called when stopped.

class FakeOsc {
  frequency = { setValueAtTime: vi.fn() };
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
  onended: (() => void) | null = null;
}

class FakeGain {
  gain = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
  connect = vi.fn();
}

class FakeAudioContext {
  state: 'suspended' | 'running' = 'suspended';
  currentTime = 0;
  destination = {};
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  close = vi.fn(async () => {});
  createOscillator = vi.fn(() => new FakeOsc());
  createGain = vi.fn(() => new FakeGain());
}

let lastCtx: FakeAudioContext | null = null;

beforeEach(() => {
  lastCtx = null;
  function AudioContextCtor() {
    lastCtx = new FakeAudioContext();
    return lastCtx;
  }
  vi.stubGlobal('AudioContext', AudioContextCtor);
  // Worker is optional in the engine — leave undefined so the scheduler
  // worker creation short-circuits and stop() is a no-op.
  vi.stubGlobal('Worker', undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
};

describe('useMetronomeEngine — visibilitychange resume', () => {
  it('resumes the AudioContext when visible while playing and ctx is suspended', () => {
    const { result } = renderHook(() => useMetronomeEngine(cfg));

    act(() => {
      result.current.start();
    });
    // start() already called resume once — clear so we can assert on the
    // visibilitychange-driven call below.
    expect(lastCtx).not.toBeNull();
    lastCtx!.resume.mockClear();
    lastCtx!.state = 'suspended';

    act(() => {
      setVisibility('hidden');
      setVisibility('visible');
    });

    expect(lastCtx!.resume).toHaveBeenCalledTimes(1);
  });

  it('does not resume when visible but the metronome is stopped', () => {
    const { result } = renderHook(() => useMetronomeEngine(cfg));

    act(() => {
      result.current.start();
      result.current.stop();
    });
    lastCtx!.resume.mockClear();
    lastCtx!.state = 'suspended';

    act(() => {
      setVisibility('visible');
    });

    expect(lastCtx!.resume).not.toHaveBeenCalled();
  });

  it('does not resume when ctx is already running (no-op fast path)', () => {
    const { result } = renderHook(() => useMetronomeEngine(cfg));

    act(() => {
      result.current.start();
    });
    lastCtx!.resume.mockClear();
    lastCtx!.state = 'running';

    act(() => {
      setVisibility('visible');
    });

    expect(lastCtx!.resume).not.toHaveBeenCalled();
  });

  it('removes the listener on unmount', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() => useMetronomeEngine(cfg));
    unmount();
    expect(
      removeSpy.mock.calls.some(([event]) => event === 'visibilitychange'),
    ).toBe(true);
  });
});
