import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePausedInterval } from './usePausedInterval';

describe('usePausedInterval', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires immediately and then every `ms` until unmounted', () => {
    const fn = vi.fn();
    const { unmount } = renderHook(() => usePausedInterval(fn, 1000));
    expect(fn).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(3000));
    // 1 initial + 3 intervals = 4
    expect(fn).toHaveBeenCalledTimes(4);
    unmount();
    act(() => vi.advanceTimersByTime(5000));
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('pauses when document is hidden and resumes on visible', () => {
    const fn = vi.fn();
    renderHook(() => usePausedInterval(fn, 500));
    expect(fn).toHaveBeenCalledTimes(1);

    // Simulate tab switch → hidden.
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    act(() => vi.advanceTimersByTime(5000));
    // No additional calls while hidden.
    expect(fn).toHaveBeenCalledTimes(1);

    // Back to visible — fires once immediately, then resumes cadence.
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(fn).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(500));
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
