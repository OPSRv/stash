import { useCallback, useEffect, useRef, useState } from 'react';

/// Tiny async-state hook. Replaces the `useState` + `useEffect` + `mountedRef`
/// boilerplate that every system panel used to hand-write for its "load a
/// list on mount, store errors, support re-refresh" flow.
///
/// Returns `{ data, error, loading, reload }`. `reload` is stable across
/// renders and returns the same promise so callers can `await` it after
/// mutations (e.g. trash a file, then `reload()` to refresh).
///
/// `immediate=false` skips the initial run — useful when the fetch depends
/// on user action (e.g. "choose folder, then scan").

export type UseAsyncState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
};

export function useAsync<T>(
  fn: () => Promise<T>,
  deps: React.DependencyList = [],
  options: { immediate?: boolean } = {},
): UseAsyncState<T> {
  const { immediate = true } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Track the latest fn so reload() (which is stable) always calls the
  // current closure. Without this, consumers would have to memoise `fn`
  // themselves or live with stale captures.
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const value = await fnRef.current();
      if (!mounted.current) return;
      setData(value);
      setError(null);
    } catch (e) {
      if (!mounted.current) return;
      setError(String(e));
    } finally {
      if (mounted.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Run whenever deps change (or on mount, if immediate).
  useEffect(() => {
    if (immediate) void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload };
}
