import type { ToastItem, ToastVariant } from './Toast.types';

interface ToastCardProps {
  toast: ToastItem;
  onDismiss: () => void;
}

// Refresh-2026-04: keep variant tints (success / error) but rebase the
// chrome on `--bg-elev` + hairline-strong + 7 px radius. Default
// variant drops the white-10 fill that fought with the new flat surfaces.
const variantBorder: Record<ToastVariant, string> = {
  default: 'var(--hairline-strong)',
  success: 'var(--color-success-border)',
  error: 'var(--color-danger-border)',
};

const variantBackground = (variant: ToastVariant): string => {
  if (variant === 'success') return 'var(--color-success-bg)';
  if (variant === 'error') return 'var(--color-danger-bg)';
  return 'var(--bg-elev)';
};

export const ToastCard = ({ toast, onDismiss }: ToastCardProps) => {
  const variant = toast.variant ?? 'default';
  return (
    <div
      role={variant === 'error' ? 'alert' : 'status'}
      className="pointer-events-auto t-primary px-3 py-2 text-[13px] stash-fade-in flex items-start gap-2"
      style={{
        background: variantBackground(variant),
        border: `0.5px solid ${variantBorder[variant]}`,
        borderRadius: 'var(--r-lg)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
      }}
    >
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{toast.title}</div>
        {toast.description ? (
          <div className="t-secondary text-meta mt-0.5 line-clamp-3">
            {toast.description}
          </div>
        ) : null}
      </div>
      {toast.action ? (
        <button
          type="button"
          onClick={() => {
            toast.action?.onClick();
            onDismiss();
          }}
          className="shrink-0 text-meta px-2 py-0.5 rounded-md"
          style={{ background: 'rgba(255,255,255,0.12)' }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 t-tertiary hover:t-primary"
      >
        ×
      </button>
    </div>
  );
};
