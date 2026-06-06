import { type ReactNode, useEffect } from 'react';

interface Props {
  open: boolean;
  title?: string;
  onClose: () => void;
  /** static — не закривати кліком по підкладці (як loadModal). */
  staticBackdrop?: boolean;
  hideClose?: boolean;
  dataId?: string;
  children: ReactNode;
  footer?: ReactNode;
}

/** Модалка на React (замість Bootstrap JS). */
export const Modal = ({
  open,
  title,
  onClose,
  staticBackdrop,
  hideClose,
  dataId,
  children,
  footer,
}: Props) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !staticBackdrop) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, staticBackdrop, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onMouseDown={() => !staticBackdrop && onClose()}
    >
      <div
        data-id={dataId}
        className="w-full max-w-md rounded-2xl border border-ve-stroke shadow-2xl"
        style={{
          background: 'linear-gradient(180deg, var(--color-ve-bg-1), #0f1217)',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {(title || !hideClose) && (
          <div className="flex items-center justify-between border-b border-ve-stroke px-4 py-3">
            <h2 className="text-base font-bold text-ve-text">{title}</h2>
            {!hideClose && (
              <button
                type="button"
                aria-label="Close"
                className="cursor-pointer text-xl leading-none text-ve-dim hover:text-white"
                onClick={onClose}
              >
                ×
              </button>
            )}
          </div>
        )}
        <div className="px-4 py-4">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-ve-stroke px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};
