import {
  forwardRef,
  useCallback,
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
} from 'react';

export type NumberInputSize = 'sm' | 'md';
export type NumberInputTone = 'default' | 'danger';

type NumberInputProps = {
  value: number | null;
  onChange: (next: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  /// Number of fraction digits to render and to round to when committing.
  /// Defaults to the fraction digits of `step` (e.g. `0.1` → 1, `1` → 0).
  precision?: number;
  placeholder?: string;
  size?: NumberInputSize;
  tone?: NumberInputTone;
  invalid?: boolean;
  disabled?: boolean;
  /// Hide the `±` stepper. Useful in dense rows where the user mostly types.
  hideStepper?: boolean;
  /// Unit rendered after the number (e.g. `px`, `s`, `%`).
  suffix?: string;
  ariaLabel?: string;
  id?: string;
  className?: string;
};

const wrapperSize: Record<NumberInputSize, string> = {
  sm: 'h-7 text-xs pl-2',
  md: 'h-9 text-[13px] pl-3',
};

/// Padding between the number and whatever sits on its right — the stepper
/// column, a suffix, or the wrapper's own right edge when both are off.
const inputPadRight: Record<NumberInputSize, string> = {
  sm: 'pr-2',
  md: 'pr-2.5',
};

const stepperBtnSize: Record<NumberInputSize, string> = {
  sm: 'w-5 h-5 text-[11px]',
  md: 'w-6 h-6 text-[13px]',
};

const clamp = (n: number, min?: number, max?: number) => {
  if (min != null && n < min) return min;
  if (max != null && n > max) return max;
  return n;
};

const fractionDigits = (step: number): number => {
  if (!isFinite(step)) return 0;
  const s = String(step);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
};

const format = (n: number, digits: number): string =>
  digits > 0 ? n.toFixed(digits) : String(Math.round(n));

export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(
  (
    {
      value,
      onChange,
      min,
      max,
      step = 1,
      precision,
      placeholder,
      size = 'md',
      tone = 'default',
      invalid,
      disabled,
      hideStepper,
      suffix,
      ariaLabel,
      id: idProp,
      className = '',
    },
    ref,
  ) => {
    const autoId = useId();
    const id = idProp ?? autoId;
    const digits = precision ?? fractionDigits(step);
    const [draft, setDraft] = useState<string | null>(null);

    const displayed = useMemo(() => {
      if (draft != null) return draft;
      if (value == null || Number.isNaN(value)) return '';
      return format(value, digits);
    }, [draft, value, digits]);

    /// A draft is "invalid" if it's non-empty and doesn't parse to a finite
    /// number. We paint the wrapper red while the user is still editing so
    /// they know Tab/Enter will revert silently otherwise.
    const draftIsInvalid =
      draft != null &&
      draft.trim() !== '' &&
      !Number.isFinite(Number(draft.replace(',', '.')));

    const commit = useCallback(
      (raw: string) => {
        setDraft(null);
        if (raw.trim() === '') {
          onChange(null);
          return;
        }
        const parsed = Number(raw.replace(',', '.'));
        if (!Number.isFinite(parsed)) {
          // revert — leave the previous value.
          return;
        }
        const clamped = clamp(parsed, min, max);
        const rounded = digits > 0
          ? Number(clamped.toFixed(digits))
          : Math.round(clamped);
        onChange(rounded);
      },
      [onChange, min, max, digits],
    );

    const nudge = useCallback(
      (direction: 1 | -1, multiplier = 1) => {
        const current = value ?? (min ?? 0);
        const next = clamp(current + direction * step * multiplier, min, max);
        const rounded = digits > 0
          ? Number(next.toFixed(digits))
          : Math.round(next);
        onChange(rounded);
      },
      [value, step, min, max, digits, onChange],
    );

    const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        nudge(1, e.shiftKey ? 10 : 1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        nudge(-1, e.shiftKey ? 10 : 1);
      } else if (e.key === 'Enter') {
        e.currentTarget.blur();
      }
    };

    const dangerCls =
      tone === 'danger' || invalid || draftIsInvalid
        ? 'border-[rgba(var(--color-danger-rgb),0.45)]'
        : '';
    const disCls = disabled ? 'opacity-40 cursor-not-allowed' : '';
    const atMin = min != null && value != null && value <= min;
    const atMax = max != null && value != null && value >= max;

    return (
      <div
        className={`input-field ring-focus-within rounded-[var(--r-lg)] flex items-center ${wrapperSize[size]} ${dangerCls} ${disCls} ${className}`.trim()}
      >
        <input
          ref={ref}
          id={id}
          type="text"
          inputMode="decimal"
          role="spinbutton"
          aria-label={ariaLabel}
          aria-invalid={invalid || draftIsInvalid || undefined}
          aria-valuenow={value ?? undefined}
          aria-valuemin={min}
          aria-valuemax={max}
          value={displayed}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={onKey}
          className={`flex-1 min-w-0 bg-transparent outline-none text-right tabular-nums ${inputPadRight[size]}`}
          style={{ fontVariantNumeric: 'tabular-nums' }}
        />
        {suffix && (
          <span className="t-tertiary pr-1.5 shrink-0 select-none">{suffix}</span>
        )}
        {!hideStepper && (
          <div className="flex flex-col border-l [border-color:var(--hairline)] shrink-0 h-full">
            <button
              type="button"
              tabIndex={-1}
              aria-label="Increment"
              disabled={disabled || atMax}
              onClick={() => nudge(1)}
              className={`${stepperBtnSize[size]} inline-flex items-center justify-center t-secondary hover:t-primary hover:[background:var(--bg-row-active)] disabled:opacity-30 disabled:hover:bg-transparent`}
              style={{ height: '50%', lineHeight: 1 }}
            >
              <span aria-hidden>▲</span>
            </button>
            <button
              type="button"
              tabIndex={-1}
              aria-label="Decrement"
              disabled={disabled || atMin}
              onClick={() => nudge(-1)}
              className={`${stepperBtnSize[size]} inline-flex items-center justify-center t-secondary hover:t-primary hover:[background:var(--bg-row-active)] disabled:opacity-30 disabled:hover:bg-transparent border-t [border-color:var(--hairline)]`}
              style={{ height: '50%', lineHeight: 1 }}
            >
              <span aria-hidden>▼</span>
            </button>
          </div>
        )}
      </div>
    );
  },
);

NumberInput.displayName = 'NumberInput';
