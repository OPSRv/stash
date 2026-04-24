import { useCallback, useReducer, useRef, useState } from 'react';

export type UndoableString = {
  value: string;
  setValue: (next: string | ((prev: string) => string)) => void;
  /** Drop the full undo/redo history and snap to `next` — used on
   *  note-switch so one note's edits can't be undone into another's. */
  reset: (next: string) => void;
  undo: () => string | undefined;
  redo: () => string | undefined;
  /** Take an immediate snapshot of the current value and suppress the
   *  debounced snapshotter until `endTransaction` flushes. Use this to
   *  wrap programmatic bulk edits (e.g. AI rewrite stream) so the whole
   *  rewrite collapses into a single undo entry. */
  beginTransaction: () => void;
  endTransaction: () => void;
  canUndo: boolean;
  canRedo: boolean;
};

/** Debounced undo/redo stack for a single string value. Rapid keystrokes
 *  coalesce into one history entry after `debounceMs` of inactivity, so
 *  the undo stack doesn't fill up with one entry per character. */
export const useUndoableString = (
  initial: string,
  debounceMs = 500,
): UndoableString => {
  const [value, setValueState] = useState(initial);
  const valueRef = useRef(initial);
  valueRef.current = value;
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  /** Last value that has been committed to history. The next snapshot
   *  compares against this, not the live value. */
  const baseline = useRef(initial);
  const timer = useRef<number | null>(null);
  const suppress = useRef(false);
  const [, forceRender] = useReducer((x: number) => x + 1, 0);

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const commit = useCallback(() => {
    clearTimer();
    if (baseline.current !== valueRef.current) {
      past.current.push(baseline.current);
      baseline.current = valueRef.current;
      future.current = [];
      forceRender();
    }
  }, []);

  const setValue = useCallback(
    (next: string | ((prev: string) => string)) => {
      const resolved = typeof next === 'function' ? next(valueRef.current) : next;
      setValueState(resolved);
      valueRef.current = resolved;
      if (suppress.current) return;
      clearTimer();
      timer.current = window.setTimeout(commit, debounceMs);
    },
    [commit, debounceMs],
  );

  const reset = useCallback((next: string) => {
    setValueState(next);
    valueRef.current = next;
    past.current = [];
    future.current = [];
    baseline.current = next;
    clearTimer();
    suppress.current = false;
    forceRender();
  }, []);

  const beginTransaction = useCallback(() => {
    // Flush anything pending so in-progress typing ends up in history
    // before the programmatic bulk edit starts.
    commit();
    suppress.current = true;
  }, [commit]);

  const endTransaction = useCallback(() => {
    suppress.current = false;
    commit();
  }, [commit]);

  const undo = useCallback((): string | undefined => {
    commit();
    const prev = past.current.pop();
    if (prev === undefined) return undefined;
    future.current.push(baseline.current);
    baseline.current = prev;
    setValueState(prev);
    valueRef.current = prev;
    forceRender();
    return prev;
  }, [commit]);

  const redo = useCallback((): string | undefined => {
    const next = future.current.pop();
    if (next === undefined) return undefined;
    past.current.push(baseline.current);
    baseline.current = next;
    setValueState(next);
    valueRef.current = next;
    forceRender();
    return next;
  }, []);

  return {
    value,
    setValue,
    reset,
    undo,
    redo,
    beginTransaction,
    endTransaction,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
};
