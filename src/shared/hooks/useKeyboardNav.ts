import { useEffect, useState } from 'react';

type Options = {
  itemCount: number;
  onSelect?: (index: number) => void;
};

export const useKeyboardNav = ({ itemCount, onSelect }: Options) => {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (index > Math.max(0, itemCount - 1)) {
      setIndex(Math.max(0, itemCount - 1));
    }
  }, [itemCount, index]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // The hook owns a window-level listener, but the clipboard popup that
      // hosts it stays mounted while other tabs (Notes editor, AI composer,
      // Translator) are active — `PopupShell` only hides them. Without this
      // guard, hitting Enter in a textarea on another tab would fire
      // `onSelect`, paste a clipboard item, and dismiss the popup.
      const target = e.target as HTMLElement | null;
      const typingInInput =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true;
      if (typingInInput) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setIndex((i) => Math.min(i + 1, Math.max(0, itemCount - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setIndex((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        setIndex((i) => {
          onSelect?.(i);
          return i;
        });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [itemCount, onSelect]);

  return { index, setIndex };
};
