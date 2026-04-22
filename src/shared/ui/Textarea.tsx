import { forwardRef, type TextareaHTMLAttributes } from 'react';

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  tone?: 'default' | 'danger';
  invalid?: boolean;
  /// Strip the bordered `input-field` look. Used by inline editors (note
  /// body, chat composer) that live inside a larger shell and just want
  /// native textarea behaviour + the app's focus-ring story. Consumers
  /// pass their own `className` for padding/typography.
  bare?: boolean;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    { rows = 3, tone = 'default', invalid, bare = false, disabled, className = '', ...rest },
    ref,
  ) => {
    const danger =
      !bare && (tone === 'danger' || invalid) ? 'border-[rgba(var(--color-danger-rgb),0.45)]' : '';
    const dis = disabled ? 'opacity-40 cursor-not-allowed' : '';
    const base = bare
      ? 'bg-transparent outline-none'
      : 'input-field ring-focus rounded-md text-body px-3 py-2 resize-y';
    return (
      <textarea
        ref={ref}
        rows={rows}
        disabled={disabled}
        className={`${base} ${danger} ${dis} ${className}`.trim()}
        {...rest}
      />
    );
  },
);

Textarea.displayName = 'Textarea';
