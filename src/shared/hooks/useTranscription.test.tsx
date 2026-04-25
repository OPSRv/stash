import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useTranscription, type TranscriptionHandlers } from './useTranscription';

/// Helper: creates a subscribe stub that captures the handlers so tests
/// can drive them directly.
function makeSubscribe() {
  let captured: TranscriptionHandlers | null = null;
  const unsub = vi.fn();

  const subscribe = vi.fn((handlers: TranscriptionHandlers) => {
    captured = handlers;
    return unsub;
  });

  const emit = {
    start: () => captured?.onStart(),
    done: (t: string) => captured?.onDone(t),
    failed: (e: string) => captured?.onFailed(e),
  };

  return { subscribe, unsub, emit };
}

describe('useTranscription', () => {
  it('exposes initial transcript value', () => {
    const { subscribe } = makeSubscribe();
    const { result } = renderHook(() =>
      useTranscription({
        initial: 'existing text',
        start: vi.fn().mockResolvedValue(undefined),
        subscribe,
      }),
    );
    expect(result.current.transcript).toBe('existing text');
    expect(result.current.status).toBe('idle');
    expect(result.current.failed).toBe(false);
  });

  it('starts as idle when initial is null', () => {
    const { subscribe } = makeSubscribe();
    const { result } = renderHook(() =>
      useTranscription({
        initial: null,
        start: vi.fn().mockResolvedValue(undefined),
        subscribe,
      }),
    );
    expect(result.current.transcript).toBeNull();
    expect(result.current.status).toBe('idle');
  });

  it('calls start() when transcribe() is called', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const { subscribe } = makeSubscribe();
    const { result } = renderHook(() =>
      useTranscription({ initial: null, start, subscribe }),
    );

    await act(async () => {
      await result.current.transcribe();
    });

    expect(start).toHaveBeenCalledOnce();
  });

  it('subscribe onStart sets status to running', () => {
    const { subscribe, emit } = makeSubscribe();
    const { result } = renderHook(() =>
      useTranscription({
        initial: null,
        start: vi.fn().mockResolvedValue(undefined),
        subscribe,
      }),
    );

    act(() => {
      emit.start();
    });

    expect(result.current.status).toBe('running');
  });

  it('subscribe onDone updates transcript and resets status to idle', () => {
    const { subscribe, emit } = makeSubscribe();
    const { result } = renderHook(() =>
      useTranscription({
        initial: null,
        start: vi.fn().mockResolvedValue(undefined),
        subscribe,
      }),
    );

    act(() => {
      emit.start();
    });
    expect(result.current.status).toBe('running');

    act(() => {
      emit.done('Привіт, світ');
    });

    expect(result.current.transcript).toBe('Привіт, світ');
    expect(result.current.status).toBe('idle');
    expect(result.current.failed).toBe(false);
  });

  it('subscribe onFailed flips status to error', () => {
    const { subscribe, emit } = makeSubscribe();
    const { result } = renderHook(() =>
      useTranscription({
        initial: null,
        start: vi.fn().mockResolvedValue(undefined),
        subscribe,
      }),
    );

    act(() => {
      emit.failed('Audio too short');
    });

    expect(result.current.status).toBe('error');
    expect(result.current.failed).toBe(true);
  });

  it('retry resets error state before calling start again', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const { subscribe, emit } = makeSubscribe();
    const { result } = renderHook(() =>
      useTranscription({ initial: null, start, subscribe }),
    );

    // First attempt fails
    act(() => {
      emit.failed('Timeout');
    });
    expect(result.current.status).toBe('error');

    // Retry
    await act(async () => {
      await result.current.transcribe();
    });

    expect(start).toHaveBeenCalledTimes(1);
    // After a successful start() call (no throw) status resets to idle
    // (the event-driven update would come via onStart/onDone in real usage).
    expect(result.current.status).toBe('idle');
  });

  it('sets error status when start() throws', async () => {
    const start = vi.fn().mockRejectedValue(new Error('Network error'));
    const { subscribe } = makeSubscribe();
    const { result } = renderHook(() =>
      useTranscription({ initial: null, start, subscribe }),
    );

    await act(async () => {
      await result.current.transcribe();
    });

    expect(result.current.status).toBe('error');
    expect(result.current.failed).toBe(true);
  });

  it('unsubscribes on unmount', () => {
    const { subscribe, unsub } = makeSubscribe();
    const { unmount } = renderHook(() =>
      useTranscription({
        initial: null,
        start: vi.fn().mockResolvedValue(undefined),
        subscribe,
      }),
    );

    unmount();
    expect(unsub).toHaveBeenCalledOnce();
  });
});
