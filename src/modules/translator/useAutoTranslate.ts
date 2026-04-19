import { useEffect, useRef } from 'react';
import { AUTO_TRANSLATE_DEBOUNCE_MS } from './translator.constants';

interface AutoTranslateArgs {
  draft: string;
  target: string;
  sourceHint: string | null;
  onTranslate: (text: string, to: string, from?: string) => void;
  onEmpty: () => void;
}

/// Debounced auto-translate: runs `onTranslate` a short delay after the
/// source text or target language changes. Skips re-runs for the exact
/// same (text, to) pair so switching focus or re-mounting doesn't fire
/// a redundant round-trip. `onEmpty` fires synchronously when the draft
/// is cleared so the UI can hide the last result immediately.
export const useAutoTranslate = ({
  draft,
  target,
  sourceHint,
  onTranslate,
  onEmpty,
}: AutoTranslateArgs): void => {
  const lastTranslatedRef = useRef<{ text: string; to: string } | null>(null);

  useEffect(() => {
    const text = draft.trim();
    if (!text) {
      lastTranslatedRef.current = null;
      onEmpty();
      return;
    }
    const last = lastTranslatedRef.current;
    if (last && last.text === text && last.to === target) return;
    const timer = window.setTimeout(() => {
      lastTranslatedRef.current = { text, to: target };
      onTranslate(text, target, sourceHint ?? undefined);
    }, AUTO_TRANSLATE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, target, sourceHint, onTranslate, onEmpty]);
};
