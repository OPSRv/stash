import { forwardRef, type TextareaHTMLAttributes } from 'react';

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  tone?: 'default' | 'danger';
  invalid?: boolean;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ rows = 3, tone = 'default', invalid, disabled, className = '', ...rest }, ref) => {
    const danger = tone === 'danger' || invalid ? 'border-[rgba(239,68,68,0.45)]' : '';
    const dis = disabled ? 'opacity-40 cursor-not-allowed' : '';
    return (
      <textarea
        ref={ref}
        rows={rows}
        disabled={disabled}
        className={`input-field rounded-md text-[13px] px-3 py-2 resize-y ${danger} ${dis} ${className}`}
        {...rest}
      />
    );
  },
);

Textarea.displayName = 'Textarea';
