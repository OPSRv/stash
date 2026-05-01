import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { Spinner } from './Spinner';
import { Tooltip } from './Tooltip';

export type ButtonVariant = 'solid' | 'soft' | 'ghost' | 'outline';
export type ButtonTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';
export type ButtonShape = 'default' | 'square' | 'pill';

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  variant?: ButtonVariant;
  tone?: ButtonTone;
  size?: ButtonSize;
  shape?: ButtonShape;
  loading?: boolean;
  fullWidth?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  stopPropagation?: boolean;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  children?: ReactNode;
};

// Refresh-2026-04 size scale: every step is 4 px shorter than before so
// chrome reads quieter. Was 20 / 28 / 32 / 36 → now 20 / 24 / 28 / 32. The
// content padding is trimmed in lockstep so the inner labels still breathe.
const sizeClass: Record<ButtonSize, string> = {
  xs: 'h-5 text-[11px] px-1.5 py-0.5 gap-1',
  sm: 'h-6 text-xs px-2 py-0.5 gap-1',
  md: 'h-7 text-[12px] px-2.5 py-1 gap-1.5',
  lg: 'h-8 text-[13px] px-3 py-1.5 gap-1.5',
};

const shapeClass: Record<ButtonShape, string> = {
  default: 'rounded-[var(--r-lg)]',
  square: 'rounded-[var(--r-lg)] aspect-square justify-center !px-0',
  pill: 'rounded-full',
};

// variant × tone class composition. Uses tokens from tokens.css where possible
// (.btn-primary, .btn-danger), inline styles for new combos.
const toneSolid: Record<ButtonTone, string> = {
  neutral:
    '[background:var(--color-surface-raised)] hover:[background:var(--color-surface-muted)] text-[rgba(255,255,255,0.92)] border [border-color:var(--hairline)]',
  accent: 'btn-primary',
  success:
    'text-white border border-black/20 [background:rgb(var(--color-success-rgb))] hover:brightness-110',
  warning:
    'text-white border border-black/20 [background:rgb(var(--color-warning-rgb))] hover:brightness-110',
  danger:
    'text-white border border-black/20 [background:rgb(var(--color-danger-rgb))] hover:brightness-110',
};

const toneSoft: Record<ButtonTone, string> = {
  neutral:
    '[background:var(--color-surface-raised)] hover:bg-white/[0.14] text-[rgba(255,255,255,0.92)] border [border-color:var(--hairline)]',
  accent:
    '[color:rgb(var(--stash-accent-rgb))] border-0 [background:var(--accent-soft)] hover:[background:rgba(var(--stash-accent-rgb),0.26)]',
  success:
    'text-[color:var(--color-success-fg)] border border-[rgba(var(--color-success-rgb),0.28)] [background:rgba(var(--color-success-rgb),0.16)] hover:[background:rgba(var(--color-success-rgb),0.24)]',
  warning:
    'text-[color:var(--color-warning-fg)] border border-[rgba(var(--color-warning-rgb),0.28)] [background:rgba(var(--color-warning-rgb),0.16)] hover:[background:rgba(var(--color-warning-rgb),0.24)]',
  danger: 'btn-danger',
};

// `ghost` defaults to fully transparent; only hover lifts to `--bg-hover`.
// Was a 0.06 white tint by default — felt loud next to the bundle's hairlines.
const toneGhost: Record<ButtonTone, string> = {
  neutral: 't-primary hover:[background:var(--bg-hover)]',
  accent: '[color:rgb(var(--stash-accent-rgb))] hover:[background:var(--bg-hover)]',
  success: 'text-[color:var(--color-success-fg)] hover:[background:var(--bg-hover)]',
  warning: 'text-[color:var(--color-warning-fg)] hover:[background:var(--bg-hover)]',
  danger: 'text-[color:var(--color-danger-fg)] hover:[background:var(--bg-hover)]',
};

const toneOutline: Record<ButtonTone, string> = {
  neutral:
    'border [border-color:var(--hairline-strong)] hover:[background:var(--bg-hover)] text-[rgba(255,255,255,0.92)]',
  accent:
    'text-[#4A8BEA] border [border-color:rgba(var(--stash-accent-rgb),0.45)] hover:[background:rgba(var(--stash-accent-rgb),0.10)]',
  success:
    'text-[color:var(--color-success-fg)] border border-[rgba(var(--color-success-rgb),0.45)] hover:[background:rgba(var(--color-success-rgb),0.10)]',
  warning:
    'text-[color:var(--color-warning-fg)] border border-[rgba(var(--color-warning-rgb),0.45)] hover:[background:rgba(var(--color-warning-rgb),0.10)]',
  danger:
    'text-[color:var(--color-danger-fg)] border border-[rgba(var(--color-danger-rgb),0.45)] hover:[background:rgba(var(--color-danger-rgb),0.10)]',
};

const variantTone = (variant: ButtonVariant, tone: ButtonTone): string => {
  switch (variant) {
    case 'solid':
      return toneSolid[tone];
    case 'soft':
      return toneSoft[tone];
    case 'outline':
      return toneOutline[tone];
    case 'ghost':
    default:
      return toneGhost[tone];
  }
};

export const Button = ({
  variant = 'ghost',
  tone = 'neutral',
  size = 'md',
  shape = 'default',
  loading = false,
  fullWidth = false,
  onClick,
  leadingIcon,
  trailingIcon,
  stopPropagation = false,
  children,
  className = '',
  type = 'button',
  disabled,
  title,
  ...rest
}: ButtonProps) => {
  const isDisabled = disabled || loading;
  const classes = [
    // `active:translate-y-[0.5px]` swaps the previous `row-base:active`
    // scale-down for the bundle's quieter "press" — a single pixel nudge,
    // matching macOS native button feedback.
    'inline-flex items-center whitespace-nowrap transition-colors duration-150 active:translate-y-[0.5px] disabled:opacity-40 disabled:cursor-not-allowed ring-focus',
    sizeClass[size],
    shapeClass[shape],
    variantTone(variant, tone),
    fullWidth ? 'w-full justify-center' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const lead = loading ? <Spinner size={size === 'xs' ? 10 : 12} /> : leadingIcon;

  return (
    <Tooltip label={title}>
      <button
        type={type}
        disabled={isDisabled}
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          onClick?.(e);
        }}
        className={classes}
        {...rest}
      >
        {lead ? <span className="inline-flex shrink-0">{lead}</span> : null}
        {children}
        {trailingIcon ? <span className="inline-flex shrink-0">{trailingIcon}</span> : null}
      </button>
    </Tooltip>
  );
};
