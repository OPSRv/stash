import { useEffect } from 'react';
import { translatorList, translatorSearch, type TranslationRow } from './api';
import { HISTORY_SEARCH_DEBOUNCE_MS } from './translator.constants';

interface HistorySearchArgs {
  query: string;
  onResults: (rows: TranslationRow[]) => void;
}

/// Debounced history search. Empty query falls back to `translatorList`
/// (full history), otherwise routes through `translatorSearch` after a
/// short delay so per-keystroke IPC doesn't flood the backend.
export const useHistorySearch = ({ query, onResults }: HistorySearchArgs): void => {
  useEffect(() => {
    const trimmed = query.trim();
    const timer = window.setTimeout(() => {
      const load = trimmed ? translatorSearch(trimmed) : translatorList();
      load.then(onResults).catch((error) => {
        console.error('translator search failed', error);
      });
    }, trimmed ? HISTORY_SEARCH_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
  }, [query, onResults]);
};
