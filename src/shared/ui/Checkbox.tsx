import { forwardRef, useEffect, useRef, type ReactNode } from 'react';
import { CheckIcon } from './icons';

export type CheckboxSize = 'sm' | 'md';

type CheckboxProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  /// Tri-state checkbox. When true, the box renders a minus instead of a
  /// check and `aria-checked` is reported as `"mixed"`. Clicking an
  /// indeterminate box calls `onChange(true)`.
  indeterminate?: boolean;
  /// Label rendered after the box. If provided, the whole row becomes a
  /// `<label>` so clicking the text also toggles.
  label?: ReactNode;
  /// Optional secondary line under the label (hint, shortcut, etc).
  description?: ReactNode;
  size?: CheckboxSize;
  disabled?: boolean;
  /// Accessible name when no visible label is given (e.g. selection boxes
  /// in a row).
  ariaLabel?: string;
  id?: string;
  name?: string;
  className?: string;
};

const boxSize: Record<CheckboxSize, string> = {
  sm: 'w-[14px] h-[14px]',
  md: 'w-4 h-4',
};

const iconSize: Record<CheckboxSize, number> = {
  sm: 10,
  md: 12,
};

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  (
    {
      checked,
      onChange,
      indeterminate = false,
      label,
      description,
      size = 'md',
      disabled = false,
      ariaLabel,
      id,
      name,
      className = '',
    },
    ref,
  ) => {
    const innerRef = useRef<HTMLInputElement | null>(null);
    useEffect(() => {
      if (innerRef.current) innerRef.current.indeterminate = indeterminate;
    }, [indeterminate]);

    const box = (
      <span
        aria-hidden
        className={`inline-flex items-center justify-center rounded-[5px] shrink-0 transition-colors duration-120 ${boxSize[size]}`}
        style={{
          background: checked || indeterminate ? 'var(--stash-accent)' : 'var(--color-surface-muted)',
          boxShadow: checked || indeterminate
            ? 'inset 0 0 0 0.5px rgba(0,0,0,0.25), 0 1px 0 rgba(255,255,255,0.08) inset'
            : 'inset 0 0 0 1px rgba(255,255,255,0.10)',
          color: '#fff',
        }}
      >
        {indeterminate ? (
          <span
            style={{
              width: size === 'sm' ? 7 : 8,
              height: 1.5,
              background: '#fff',
              borderRadius: 1,
              display: 'block',
            }}
          />
        ) : checked ? (
          <CheckIcon size={iconSize[size]} />
        ) : null}
      </span>
    );

    const input = (
      <input
        ref={(node) => {
          innerRef.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) ref.current = node;
        }}
        id={id}
        name={name}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-checked={indeterminate ? 'mixed' : checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
        className="peer sr-only"
      />
    );

    const boxWithFocus = (
      <span className="relative inline-flex rounded-[6px] peer-focus-visible:[box-shadow:var(--ring-focus-sm)]">
        {box}
      </span>
    );

    const disabledCls = disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer';

    if (label == null && description == null) {
      return (
        <label className={`inline-flex items-center ${disabledCls} ${className}`.trim()}>
          {input}
          {boxWithFocus}
        </label>
      );
    }

    return (
      <label
        className={`inline-flex items-start gap-2 ${disabledCls} ${className}`.trim()}
      >
        {input}
        {boxWithFocus}
        <span className="flex flex-col gap-0.5 min-w-0">
          {label != null && (
            <span className="t-primary text-body leading-tight">{label}</span>
          )}
          {description != null && (
            <span className="t-tertiary text-meta leading-snug">{description}</span>
          )}
        </span>
      </label>
    );
  },
);

Checkbox.displayName = 'Checkbox';
