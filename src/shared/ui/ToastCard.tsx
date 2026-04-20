import type { ToastItem, ToastVariant } from './Toast.types';

interface ToastCardProps {
  toast: ToastItem;
  onDismiss: () => void;
}

const variantClasses: Record<ToastVariant, string> = {
  default: 'bg-white/10 border-white/[0.05] t-primary',
  success: 'border-emerald-400/30 t-primary',
  error: 'border-red-400/40 t-primary',
};

const variantBackground = (variant: ToastVariant): string | undefined => {
  if (variant === 'success') return 'var(--color-success-bg)';
  if (variant === 'error') return 'var(--color-danger-bg)';
  return undefined;
};

export const ToastCard = ({ toast, onDismiss }: ToastCardProps) => {
  const variant = toast.variant ?? 'default';
  return (
    <div
      role={variant === 'error' ? 'alert' : 'status'}
      className={`pointer-events-auto pane rounded-md px-3 py-2 text-[13px] shadow-lg border stash-fade-in ${variantClasses[variant]} flex items-start gap-2`}
      style={{ background: variantBackground(variant) }}
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
