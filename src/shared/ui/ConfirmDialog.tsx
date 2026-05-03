import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button';
import { Checkbox } from './Checkbox';
import { useFocusTrap } from './useFocusTrap';

type Props = {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  /** When provided, renders a "Don't ask again" checkbox. */
  suppressibleLabel?: string;
  onConfirm: (suppress?: boolean) => void;
  onCancel: () => void;
};

export const ConfirmDialog = ({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  suppressibleLabel,
  onConfirm,
  onCancel,
}: Props) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const [suppress, setSuppress] = useState(false);

  useFocusTrap(panelRef, open, { initialFocus: tone === 'danger' ? 'first' : 'last' });

  useEffect(() => {
    if (!open) setSuppress(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Capture-phase + stopImmediatePropagation so PopupShell's
        // window Esc handler doesn't hide the whole popup behind the
        // dialog. Same fix applied in `Modal`/`Lightbox`.
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter') {
        const active = document.activeElement as HTMLElement | null;
        if (active?.dataset.role === 'confirm-cancel') return;
        e.preventDefault();
        onConfirm(suppressibleLabel ? suppress : undefined);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onConfirm, onCancel, suppress, suppressibleLabel]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="modal-backdrop fixed inset-0 z-[70] flex items-center justify-center p-6"
      onClick={onCancel}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal-panel max-w-[420px] w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="t-primary text-title font-semibold mb-1">{title}</div>
        {description ? (
          <div className="t-secondary text-body mb-3">{description}</div>
        ) : (
          <div className="mb-2" />
        )}
        {suppressibleLabel && (
          <div className="mt-2">
            <Checkbox
              size="sm"
              checked={suppress}
              onChange={setSuppress}
              label={<span className="t-secondary text-meta">{suppressibleLabel}</span>}
            />
          </div>
        )}
        <div className="flex items-center justify-end gap-2 mt-3">
          <Button onClick={onCancel} variant="ghost" data-role="confirm-cancel">
            {cancelLabel}
          </Button>
          <Button
            onClick={() => onConfirm(suppressibleLabel ? suppress : undefined)}
            variant="solid"
            tone={tone === 'danger' ? 'danger' : 'accent'}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
