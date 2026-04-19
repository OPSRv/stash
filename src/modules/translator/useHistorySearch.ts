import { useEffect } from 'react';
import { translatorList, translatorSearch, type TranslationRow } from './api';
import { HISTORY_SEARCH_DEBOUNCE_MS } from './translator.constants';

interface HistorySearchArgs {
  query: string;
  reloadKey: number;
  onResults: (rows: TranslationRow[]) => void;
}

/// Debounced history search. Empty query falls back to `translatorList`
/// (full history), otherwise routes through `translatorSearch` after a
/// short delay so per-keystroke IPC doesn't flood the backend. `reloadKey`
/// forces a refetch when the caller mutates history out-of-band (delete,
/// clear, incoming auto-translate). In-flight responses are discarded if
/// a newer query arrives before they resolve.
export const useHistorySearch = ({
  query,
  reloadKey,
  onResults,
}: HistorySearchArgs): void => {
  useEffect(() => {
    const trimmed = query.trim();
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const load = trimmed ? translatorSearch(trimmed) : translatorList();
      load
        .then((rows) => {
          if (!cancelled) onResults(rows);
        })
        .catch((error) => {
          if (!cancelled) console.error('translator search failed', error);
        });
    }, trimmed ? HISTORY_SEARCH_DEBOUNCE_MS : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, reloadKey, onResults]);
};
