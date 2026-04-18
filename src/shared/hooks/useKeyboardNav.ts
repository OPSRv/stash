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
