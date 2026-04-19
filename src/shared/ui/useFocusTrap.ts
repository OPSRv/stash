import { useEffect, type RefObject } from 'react';

type Options = {
  initialFocus?: 'first' | 'last' | RefObject<HTMLElement | null>;
  restoreFocus?: boolean;
};

const SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const tabbables = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>(SELECTOR)).filter(
    (el) => !el.hasAttribute('aria-hidden'),
  );

export const useFocusTrap = (
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  options: Options = {},
) => {
  const { initialFocus = 'first', restoreFocus = true } = options;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;
    const previouslyFocused =
      typeof document !== 'undefined'
        ? (document.activeElement as HTMLElement | null)
        : null;

    const focusTarget = () => {
      if (initialFocus && typeof initialFocus === 'object' && initialFocus.current) {
        initialFocus.current.focus();
        return;
      }
      const items = tabbables(container);
      if (items.length === 0) {
        container.setAttribute('tabindex', '-1');
        container.focus();
        return;
      }
      if (initialFocus === 'last') items[items.length - 1].focus();
      else items[0].focus();
    };
    focusTarget();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = tabbables(container);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !container.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    container.addEventListener('keydown', onKey);
    return () => {
      container.removeEventListener('keydown', onKey);
      if (restoreFocus && previouslyFocused && previouslyFocused.focus) {
        try {
          previouslyFocused.focus();
        } catch {
          /* noop */
        }
      }
    };
  }, [active, containerRef, initialFocus, restoreFocus]);
};
