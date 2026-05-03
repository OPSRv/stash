import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useFocusTrap } from './useFocusTrap';

export type DrawerSide = 'left' | 'right';

type DrawerProps = {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  children: ReactNode;
  /// Side the drawer slides in from. Defaults to `right` because that's
  /// where the macOS-native «inspector» sits.
  side?: DrawerSide;
  /// Width of the drawer panel. Accepts a pixel number or any CSS length.
  width?: number | string;
  /// Close on click outside the panel. Default `true`.
  dismissOnBackdropClick?: boolean;
  /// Close on Escape. Default `true`.
  dismissOnEscape?: boolean;
  /// Initial focus target inside the trap.
  initialFocus?: 'first' | 'last';
  panelClassName?: string;
};

/// Side-anchored sliding panel. Complements `Modal` (centered) for cases
/// where you want an «inspector» experience — lookup history, filters,
/// a secondary column that overlays the primary view without hiding it.
/// Focus-trapped + Escape-dismissible like every other overlay in the app.
export const Drawer = ({
  open,
  onClose,
  ariaLabel,
  children,
  side = 'right',
  width = 360,
  dismissOnBackdropClick = true,
  dismissOnEscape = true,
  initialFocus = 'first',
  panelClassName = 'pane h-full overflow-auto',
}: DrawerProps) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(open);
  const [closing, setClosing] = useState(false);

  useFocusTrap(panelRef, open && rendered, { initialFocus });

  useEffect(() => {
    if (open) {
      setRendered(true);
      setClosing(false);
    } else if (rendered) {
      setClosing(true);
    }
  }, [open, rendered]);

  useEffect(() => {
    if (!open || !dismissOnEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Capture-phase + stopImmediatePropagation so PopupShell's
      // window Esc handler doesn't hide the whole Stash popup behind
      // the drawer. Same fix as `Modal`/`Lightbox`/`ConfirmDialog`.
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose, dismissOnEscape]);

  if (!rendered) return null;

  const translateFrom = side === 'right' ? '100%' : '-100%';
  const panelStyle: React.CSSProperties = {
    width,
    maxWidth: '100%',
    transform: closing ? `translateX(${translateFrom})` : 'translateX(0)',
    transition: 'transform var(--duration-base) var(--easing-emphasized)',
    [side]: 0,
  };

  return (
    <div
      data-drawer-backdrop
      className="absolute inset-0"
      style={{
        background: closing ? 'rgba(0,0,0,0)' : 'rgba(0,0,0,0.45)',
        transition: 'background var(--duration-base) var(--easing-standard)',
        zIndex: 'var(--z-overlay)' as unknown as number,
      }}
      onClick={dismissOnBackdropClick ? onClose : undefined}
      onTransitionEnd={() => {
        if (closing) {
          setRendered(false);
          setClosing(false);
        }
      }}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className={`absolute top-0 bottom-0 ${panelClassName}`}
        style={panelStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
};
