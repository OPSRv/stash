import { useEffect, useRef, type ReactNode } from 'react';
import { useFocusTrap } from './useFocusTrap';

type Props = {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  children: ReactNode;
  /** Panel className — override or extend default `.pane rounded-xl p-4`. */
  panelClassName?: string;
  /** Initial focus inside the trap. */
  initialFocus?: 'first' | 'last';
  /** Close on click outside panel. Default true. */
  dismissOnBackdropClick?: boolean;
  /** Close on Escape. Default true. */
  dismissOnEscape?: boolean;
  /** Width constraint inline. */
  maxWidth?: number;
};

export const Modal = ({
  open,
  onClose,
  ariaLabel,
  children,
  // Refresh-2026-04: default panel chrome is the shared `.modal-panel`
  // (opaque elevated surface, hairline-strong border, 12 px radius, the
  // floating-overlay shadow). Callers can still override.
  panelClassName = 'modal-panel',
  initialFocus = 'first',
  dismissOnBackdropClick = true,
  dismissOnEscape = true,
  maxWidth,
}: Props) => {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, open, { initialFocus });

  useEffect(() => {
    if (!open || !dismissOnEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Capture phase + `stopImmediatePropagation` so PopupShell's
      // window-level Esc handler — which would otherwise hide the entire
      // Stash popup — doesn't fire while a modal is open. Both listeners
      // sit on the same `window` target; without this guard the
      // PopupShell handler runs first (registered earlier) and dismisses
      // the popup before the modal closes.
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose, dismissOnEscape]);

  if (!open) return null;
  return (
    <div
      data-modal-backdrop
      className="stash-fade-in modal-backdrop absolute inset-0 flex items-center justify-center p-6"
      style={{
        zIndex: 'var(--z-modal)' as unknown as number,
      }}
      onClick={dismissOnBackdropClick ? onClose : undefined}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className={`stash-pop-in ${panelClassName}`}
        style={maxWidth ? { maxWidth, width: '100%' } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
};
