import { act, renderHook } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { useUndoableString } from './useUndoableString';

describe('useUndoableString', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces rapid edits into a single undo entry', () => {
    const { result } = renderHook(() => useUndoableString('hello', 500));

    act(() => result.current.setValue('hell'));
    act(() => result.current.setValue('hel'));
    act(() => result.current.setValue('he'));
    expect(result.current.canUndo).toBe(false);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.canUndo).toBe(true);

    act(() => {
      const prev = result.current.undo();
      expect(prev).toBe('hello');
    });
    expect(result.current.value).toBe('hello');
    expect(result.current.canRedo).toBe(true);

    act(() => {
      const next = result.current.redo();
      expect(next).toBe('he');
    });
    expect(result.current.value).toBe('he');
  });

  it('collapses a transaction into one undo entry', () => {
    const { result } = renderHook(() => useUndoableString('ORIGINAL', 500));

    act(() => result.current.beginTransaction());
    act(() => result.current.setValue('p'));
    act(() => result.current.setValue('pa'));
    act(() => result.current.setValue('par'));
    act(() => result.current.setValue('part'));
    // During a transaction the debounce timer must NOT fire snapshots,
    // otherwise intermediate streaming frames would pollute history.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.canUndo).toBe(false);

    act(() => result.current.endTransaction());
    expect(result.current.canUndo).toBe(true);

    act(() => {
      const prev = result.current.undo();
      expect(prev).toBe('ORIGINAL');
    });
  });

  it('reset clears history and baseline', () => {
    const { result } = renderHook(() => useUndoableString('a', 500));
    act(() => result.current.setValue('ab'));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.canUndo).toBe(true);

    act(() => result.current.reset('z'));
    expect(result.current.value).toBe('z');
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('aborted transaction with revert to original produces no history', () => {
    const { result } = renderHook(() => useUndoableString('ORIGINAL', 500));

    act(() => result.current.beginTransaction());
    act(() => result.current.setValue('partial'));
    // Simulate abort-revert: caller restores the pre-stream value before
    // ending the transaction. Because value === baseline at commit time,
    // no entry should be pushed.
    act(() => result.current.setValue('ORIGINAL'));
    act(() => result.current.endTransaction());

    expect(result.current.canUndo).toBe(false);
    expect(result.current.value).toBe('ORIGINAL');
  });
});
