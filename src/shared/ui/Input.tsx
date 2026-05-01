import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';

export type InputSize = 'sm' | 'md';
export type InputTone = 'default' | 'danger';

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  size?: InputSize;
  tone?: InputTone;
  leadingIcon?: ReactNode;
  trailing?: ReactNode;
  invalid?: boolean;
};

const wrapperSize: Record<InputSize, string> = {
  sm: 'h-7 text-xs px-2 gap-1.5',
  md: 'h-9 text-[13px] px-3 gap-2',
};

const bareSize: Record<InputSize, string> = {
  sm: 'h-7 text-xs px-2',
  md: 'h-9 text-[13px] px-3',
};

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    { size = 'md', tone = 'default', leadingIcon, trailing, invalid, disabled, className = '', ...rest },
    ref,
  ) => {
    const danger = tone === 'danger' || invalid ? 'border-[rgba(var(--color-danger-rgb),0.45)]' : '';
    const dis = disabled ? 'opacity-40 cursor-not-allowed' : '';

    if (leadingIcon != null || trailing != null) {
      return (
        <div
          className={`input-field ring-focus-within rounded-[var(--r-lg)] flex items-center ${wrapperSize[size]} ${danger} ${dis} ${className}`}
        >
          {leadingIcon != null && <span className="t-tertiary inline-flex shrink-0">{leadingIcon}</span>}
          <input
            ref={ref}
            disabled={disabled}
            className="flex-1 min-w-0 bg-transparent outline-none"
            {...rest}
          />
          {trailing != null && <span className="inline-flex shrink-0">{trailing}</span>}
        </div>
      );
    }

    return (
      <input
        ref={ref}
        disabled={disabled}
        className={`input-field ring-focus rounded-[var(--r-lg)] ${bareSize[size]} ${danger} ${dis} ${className}`}
        {...rest}
      />
    );
  },
);

Input.displayName = 'Input';
