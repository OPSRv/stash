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
  panelClassName = 'pane rounded-xl p-4',
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
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, dismissOnEscape]);

  if (!open) return null;
  return (
    <div
      data-modal-backdrop
      className="absolute inset-0 flex items-center justify-center p-6"
      style={{
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
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
        className={panelClassName}
        style={maxWidth ? { maxWidth, width: '100%' } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
};
