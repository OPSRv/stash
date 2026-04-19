import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ToastCard } from './ToastCard';
import type { ToastInput, ToastItem } from './Toast.types';

export type { ToastInput, ToastVariant, ToastAction, ToastItem } from './Toast.types';

const MAX_VISIBLE = 3;

interface ToastCtx {
  toast: (input: ToastInput) => () => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastCtx | null>(null);

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
      // Error variants stick around longer so users can actually read what
      // went wrong before the toast fades.
      const defaultDuration = input.variant === 'error' ? 7500 : 4000;
      const duration = input.durationMs ?? defaultDuration;
      setItems((prev) => {
        const next = [...prev, { ...input, id }];
        // Cap visible stack — oldest toasts drop off first. Cancel their
        // scheduled dismiss timers so they don't fire against ids that are
        // already gone from view.
        const overflow = next.length - MAX_VISIBLE;
        if (overflow > 0) {
          for (const evicted of next.slice(0, overflow)) {
            const t = timersRef.current.get(evicted.id);
            if (t !== undefined) {
              window.clearTimeout(t);
              timersRef.current.delete(evicted.id);
            }
          }
        }
        return next.slice(-MAX_VISIBLE);
      });
      if (duration > 0) {
        const timer = window.setTimeout(() => dismiss(id), duration);
        timersRef.current.set(id, timer);
      }
      return () => dismiss(id);
    },
    [dismiss],
  );

  useEffect(
    () => () => {
      timersRef.current.forEach((t) => window.clearTimeout(t));
      timersRef.current.clear();
    },
    [],
  );

  return (
    <ToastContext.Provider value={{ toast, dismiss }}>
      {children}
      <div
        className="pointer-events-none absolute bottom-3 right-3 flex flex-col gap-2 max-w-[340px] z-50"
        aria-live="polite"
      >
        {items.map((item) => (
          <ToastCard key={item.id} toast={item} onDismiss={() => dismiss(item.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastCtx => {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    return { toast: () => () => {}, dismiss: () => {} };
  }
  return ctx;
};
