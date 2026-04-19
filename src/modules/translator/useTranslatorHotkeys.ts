import { useEffect, type RefObject } from 'react';

interface HotkeyArgs {
  sourceRef: RefObject<HTMLTextAreaElement | null>;
  canSwap: boolean;
  hasDraft: boolean;
  onSwap: () => void;
  onClearDraft: () => void;
}

/// Module-scoped keyboard shortcuts for Translator:
///   ⌘K  — focus + select the source textarea
///   ⌘⇧S — swap languages (no-op when detection doesn't give us a real pair)
///   Esc — clear the source (only when the user isn't actively typing in a
///         different input, and only when there's something to clear)
export const useTranslatorHotkeys = ({
  sourceRef,
  canSwap,
  hasDraft,
  onSwap,
  onClearDraft,
}: HotkeyArgs): void => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        sourceRef.current?.focus();
        sourceRef.current?.select();
        return;
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === 's'
      ) {
        event.preventDefault();
        if (canSwap) onSwap();
        return;
      }
      if (event.key === 'Escape' && !isTyping && hasDraft) {
        event.preventDefault();
        onClearDraft();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sourceRef, canSwap, hasDraft, onSwap, onClearDraft]);
};
