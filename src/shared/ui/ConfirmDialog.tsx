import { useEffect, useRef } from 'react';
import { Button } from './Button';
import { useFocusTrap } from './useFocusTrap';

type Props = {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
};

export const ConfirmDialog = ({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  onConfirm,
  onCancel,
}: Props) => {
  const panelRef = useRef<HTMLDivElement>(null);

  useFocusTrap(panelRef, open, { initialFocus: tone === 'danger' ? 'first' : 'last' });

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
        onConfirm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onConfirm, onCancel]);

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
        <div className="flex justify-end gap-2 mt-2">
          <Button onClick={onCancel} variant="ghost" data-role="confirm-cancel">
            {cancelLabel}
          </Button>
          <Button
            onClick={onConfirm}
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
