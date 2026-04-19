import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

type Variant = 'default' | 'success' | 'error';

type ToastAction = { label: string; onClick: () => void };

export type ToastInput = {
  title: string;
  description?: string;
  variant?: Variant;
  action?: ToastAction;
  durationMs?: number;
};

type ToastItem = Required<Pick<ToastInput, 'title'>> &
  ToastInput & { id: number };

const MAX_VISIBLE = 3;

type Ctx = {
  toast: (input: ToastInput) => () => void;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<Ctx | null>(null);

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);
  const timersRef = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = ++idRef.current;
      const variant = input.variant ?? 'default';
      const duration =
        input.durationMs ?? (variant === 'error' ? 7000 : 4500);
      setItems((prev) => [...prev, { id, ...input, variant }]);
      if (duration > 0) {
        const timer = window.setTimeout(() => dismiss(id), duration);
        timersRef.current.set(id, timer);
      }
      return () => dismiss(id);
    },
    [dismiss],
  );

  useEffect(() => {
    return () => {
      timersRef.current.forEach((t) => window.clearTimeout(t));
      timersRef.current.clear();
    };
  }, []);

  const visible = items.slice(-MAX_VISIBLE);

  return (
    <ToastContext.Provider value={{ toast, dismiss }}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none absolute bottom-2 right-2 z-[60] flex flex-col gap-1.5 max-w-[320px]"
      >
        {visible.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
};

const variantStyle: Record<Variant, string> = {
  default: 'bg-white/10 border-white/10 t-primary',
  success: 'border-emerald-400/30 t-primary',
  error: 'border-red-400/40 t-primary',
};

const ToastCard = ({
  toast,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: () => void;
}) => {
  const variant = toast.variant ?? 'default';
  return (
    <div
      role={variant === 'error' ? 'alert' : 'status'}
      className={`pointer-events-auto pane rounded-md px-3 py-2 text-[13px] shadow-lg border stash-fade-in ${variantStyle[variant]} flex items-start gap-2`}
      style={
        variant === 'success'
          ? { background: 'var(--color-success-bg)' }
          : variant === 'error'
          ? { background: 'var(--color-danger-bg)' }
          : undefined
      }
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

export const useToast = () => {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    return { toast: () => () => {}, dismiss: () => {} } as Ctx;
  }
  return ctx;
};
