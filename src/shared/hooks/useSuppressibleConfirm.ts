import { useCallback, useEffect, useState } from 'react';

const STORAGE_PREFIX = 'stash.confirm.suppress.';

const read = (key: string): boolean => {
  try {
    return localStorage.getItem(STORAGE_PREFIX + key) === '1';
  } catch {
    return false;
  }
};

const write = (key: string, suppressed: boolean) => {
  try {
    if (suppressed) localStorage.setItem(STORAGE_PREFIX + key, '1');
    else localStorage.removeItem(STORAGE_PREFIX + key);
  } catch {
    /* ignore */
  }
};

/**
 * Hook for destructive confirms with optional "Don't ask again" persistence.
 *
 * Call `request(payload, run)` to either (a) run immediately if suppressed,
 * or (b) open a confirm dialog. `confirm(suppress)` executes the pending
 * action and optionally persists the suppression for the given `key`.
 */
export function useSuppressibleConfirm<T>(key: string) {
  const [pending, setPending] = useState<{ payload: T; run: (p: T) => void } | null>(null);
  const [suppressed, setSuppressed] = useState(() => read(key));

  useEffect(() => {
    setSuppressed(read(key));
  }, [key]);

  const request = useCallback(
    (payload: T, run: (p: T) => void) => {
      if (read(key)) {
        run(payload);
        return;
      }
      setPending({ payload, run });
    },
    [key],
  );

  const confirm = useCallback(
    (suppress: boolean) => {
      if (!pending) return;
      if (suppress) {
        write(key, true);
        setSuppressed(true);
      }
      pending.run(pending.payload);
      setPending(null);
    },
    [key, pending],
  );

  const cancel = useCallback(() => setPending(null), []);

  const reset = useCallback(() => {
    write(key, false);
    setSuppressed(false);
  }, [key]);

  return { pending, open: pending !== null, request, confirm, cancel, suppressed, reset };
}
