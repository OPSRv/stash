import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { useRunTranslate } from './useRunTranslate';

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockInvoke.mockReset();
});

describe('useRunTranslate', () => {
  it('exposes liveResult from a successful translate', async () => {
    mockInvoke.mockResolvedValueOnce({
      original: 'hello',
      translated: 'привіт',
      from: 'en',
      to: 'uk',
    });
    const { result } = renderHook(() => useRunTranslate({ onToast: vi.fn(), onAnnounce: vi.fn() }));
    await act(async () => {
      await result.current.run('hello', 'uk');
    });
    expect(result.current.liveResult?.translated).toBe('привіт');
  });

  it('drops stale responses — newer run wins even if an older call resolves last', async () => {
    let resolveSlow!: (value: unknown) => void;
    mockInvoke
      .mockImplementationOnce(
        () => new Promise((res) => { resolveSlow = res; }),
      )
      .mockResolvedValueOnce({
        original: 'goodbye',
        translated: 'до побачення',
        from: 'en',
        to: 'uk',
      });

    const { result } = renderHook(() => useRunTranslate({ onToast: vi.fn(), onAnnounce: vi.fn() }));

    // Fire slow first, then fast — don't await the slow run.
    let slowPromise!: Promise<void>;
    act(() => {
      slowPromise = result.current.run('hello', 'uk');
    });
    await act(async () => {
      await result.current.run('goodbye', 'uk');
    });
    expect(result.current.liveResult?.translated).toBe('до побачення');

    // Resolve the stale call and let microtasks flush.
    await act(async () => {
      resolveSlow({ original: 'hello', translated: 'привіт', from: 'en', to: 'uk' });
      await slowPromise;
    });

    expect(result.current.liveResult?.translated).toBe('до побачення');
    expect(result.current.liveResult?.translated).not.toBe('привіт');
  });

  it('reset() clears liveResult', async () => {
    mockInvoke.mockResolvedValueOnce({
      original: 'hi',
      translated: 'привіт',
      from: 'en',
      to: 'uk',
    });
    const { result } = renderHook(() => useRunTranslate({ onToast: vi.fn(), onAnnounce: vi.fn() }));
    await act(async () => {
      await result.current.run('hi', 'uk');
    });
    await waitFor(() => expect(result.current.liveResult).not.toBeNull());
    act(() => result.current.reset());
    expect(result.current.liveResult).toBeNull();
  });
});
