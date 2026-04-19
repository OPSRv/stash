export type ToastVariant = 'default' | 'success' | 'error';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
  action?: ToastAction;
  durationMs?: number;
}

export type ToastItem = ToastInput & {
  id: number;
  title: string;
};
