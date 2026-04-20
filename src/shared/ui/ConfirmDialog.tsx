import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
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
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter') {
        const active = document.activeElement as HTMLElement | null;
        if (active?.dataset.role === 'confirm-cancel') return;
        e.preventDefault();
        onConfirm(suppressibleLabel ? suppress : undefined);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onConfirm, onCancel, suppress, suppressibleLabel]);

  if (!open) return null;
  return (
    <div
      className="absolute inset-0 z-[70] flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(8px)' }}
      onClick={onCancel}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="pane rounded-xl p-4 max-w-[420px] w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="t-primary text-title font-semibold mb-1">{title}</div>
        {description ? (
          <div className="t-secondary text-body mb-3">{description}</div>
        ) : (
          <div className="mb-2" />
        )}
        {suppressibleLabel && (
          <label className="flex items-center gap-1.5 t-secondary text-meta select-none cursor-pointer mt-2">
            <input
              type="checkbox"
              checked={suppress}
              onChange={(e) => setSuppress(e.target.checked)}
              className="ring-focus shrink-0"
            />
            <span>{suppressibleLabel}</span>
          </label>
        )}
        <div className="flex items-center justify-end gap-2 mt-3">
          <Button onClick={onCancel} variant="ghost" data-role="confirm-cancel">
            {cancelLabel}
          </Button>
          <Button
            onClick={() => onConfirm(suppressibleLabel ? suppress : undefined)}
            variant={tone === 'danger' ? 'soft' : 'solid'}
            tone={tone === 'danger' ? 'danger' : 'accent'}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
};
