import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';

type Side = 'top' | 'bottom' | 'left' | 'right';

type TooltipProps = {
  label?: string;
  children: ReactNode;
  /** Preferred side. Tooltip auto-flips when the chosen side has no room
   *  in the viewport, so this is a hint, not a guarantee. */
  side?: Side;
};

// Refresh-2026-04: bundle uses a 400 ms show-delay (matches macOS native
// tooltip latency) — long enough that users hovering past a button don't
// see flashes, short enough that intentional rest reveals it quickly.
const SHOW_DELAY_MS = 400;
const GAP = 6;
const VIEWPORT_MARGIN = 4;

type Cloneable = {
  className?: string;
  children?: ReactNode;
  ref?: Ref<HTMLElement>;
  onMouseEnter?: (e: ReactMouseEvent) => void;
  onMouseLeave?: (e: ReactMouseEvent) => void;
  onFocus?: (e: ReactFocusEvent) => void;
  onBlur?: (e: ReactFocusEvent) => void;
};

/** Hover/focus tooltip rendered through a body-level portal with
 *  `position: fixed`, so it always paints on top and is never clipped by
 *  ancestor `overflow: hidden` / stacking contexts. The chosen `side` is a
 *  preference — if there isn't room on that side, the bubble auto-flips to
 *  the first side that fits, then clamps to the viewport edges.
 *
 *  The trigger element is decorated in place via cloneElement (no wrapper),
 *  so flex/grid layout (`flex-1`, `w-full`, `shrink-0`) keeps working.
 *  Children that cannot accept arbitrary DOM children (e.g. `<input>`,
 *  `<select>`) must be wrapped by the caller in a `<span>` first.
 */
export const Tooltip = ({ label, children, side = 'top' }: TooltipProps) => {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({
    position: 'fixed',
    top: -9999,
    left: -9999,
    opacity: 0,
    pointerEvents: 'none',
    zIndex: 9999,
  });
  const triggerRef = useRef<HTMLElement | null>(null);
  const labelRef = useRef<HTMLDivElement | null>(null);
  const showTimer = useRef<number | null>(null);

  const cancelShow = () => {
    if (showTimer.current !== null) {
      window.clearTimeout(showTimer.current);
      showTimer.current = null;
    }
  };

  useEffect(() => () => cancelShow(), []);

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    const lbl = labelRef.current;
    if (!trigger || !lbl) return;
    const r = trigger.getBoundingClientRect();
    const lw = lbl.offsetWidth;
    const lh = lbl.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const order: Side[] =
      side === 'top'
        ? ['top', 'bottom', 'right', 'left']
        : side === 'bottom'
          ? ['bottom', 'top', 'right', 'left']
          : side === 'right'
            ? ['right', 'left', 'top', 'bottom']
            : ['left', 'right', 'top', 'bottom'];

    const fits = (s: Side): boolean => {
      if (s === 'top') return r.top - GAP - lh >= VIEWPORT_MARGIN;
      if (s === 'bottom') return vh - r.bottom - GAP - lh >= VIEWPORT_MARGIN;
      if (s === 'left') return r.left - GAP - lw >= VIEWPORT_MARGIN;
      return vw - r.right - GAP - lw >= VIEWPORT_MARGIN;
    };
    const chosen = order.find(fits) ?? side;

    let top = 0;
    let left = 0;
    if (chosen === 'top' || chosen === 'bottom') {
      left = Math.round(r.left + r.width / 2 - lw / 2);
      left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - lw - VIEWPORT_MARGIN));
      top = chosen === 'top' ? Math.round(r.top - GAP - lh) : Math.round(r.bottom + GAP);
    } else {
      top = Math.round(r.top + r.height / 2 - lh / 2);
      top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - lh - VIEWPORT_MARGIN));
      left = chosen === 'left' ? Math.round(r.left - GAP - lw) : Math.round(r.right + GAP);
    }

    setStyle({
      position: 'fixed',
      top,
      left,
      opacity: 1,
      pointerEvents: 'none',
      zIndex: 9999,
    });
  }, [side]);

  // Position whenever the bubble is visible, and re-position on scroll/resize
  // so it stays glued to the trigger when the user scrolls a parent list.
  useLayoutEffect(() => {
    if (!open) {
      // Hide off-screen so it doesn't intercept layout while closed.
      setStyle((prev) => ({ ...prev, opacity: 0 }));
      return;
    }
    reposition();
    const handler = () => reposition();
    window.addEventListener('scroll', handler, true);
    window.addEventListener('resize', handler);
    return () => {
      window.removeEventListener('scroll', handler, true);
      window.removeEventListener('resize', handler);
    };
  }, [open, label, reposition]);

  if (!label || !isValidElement(children)) return <>{children}</>;
  const child = children as ReactElement<Cloneable>;

  const setRef = (node: HTMLElement | null) => {
    triggerRef.current = node;
    const r = (child as unknown as { ref?: Ref<HTMLElement> }).ref;
    if (typeof r === 'function') r(node);
    else if (r && typeof r === 'object') (r as { current: HTMLElement | null }).current = node;
  };

  const onMouseEnter = (e: ReactMouseEvent) => {
    child.props.onMouseEnter?.(e);
    cancelShow();
    showTimer.current = window.setTimeout(() => setOpen(true), SHOW_DELAY_MS);
  };
  const onMouseLeave = (e: ReactMouseEvent) => {
    child.props.onMouseLeave?.(e);
    cancelShow();
    setOpen(false);
  };
  const onFocus = (e: ReactFocusEvent) => {
    child.props.onFocus?.(e);
    cancelShow();
    setOpen(true);
  };
  const onBlur = (e: ReactFocusEvent) => {
    child.props.onBlur?.(e);
    cancelShow();
    setOpen(false);
  };

  const cloned = cloneElement(child, {
    ref: setRef,
    onMouseEnter,
    onMouseLeave,
    onFocus,
    onBlur,
  } as unknown as Cloneable);

  // Always render the bubble in DOM (just transparent + off-screen when
  // closed) so accessibility queries / tests can find it via role="tooltip"
  // without simulating hover. Mounting on demand would also drop the portal
  // out of body, breaking testing-library's `getAllByRole('tooltip', { hidden: true })`.
  const portal =
    typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={labelRef}
            role="tooltip"
            aria-hidden={!open}
            className="tip-label tip-label--portal"
            style={style}
          >
            {label}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      {cloned}
      {portal}
    </>
  );
};
