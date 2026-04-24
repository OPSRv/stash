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

const sizeClass: Record<ButtonSize, string> = {
  xs: 'h-5 text-[11px] px-1.5 py-0.5 gap-1',
  sm: 'h-7 text-xs px-2 py-1 gap-1',
  md: 'h-8 text-[13px] px-2.5 py-1.5 gap-1.5',
  lg: 'h-9 text-sm px-3.5 py-2 gap-1.5',
};

const shapeClass: Record<ButtonShape, string> = {
  default: 'rounded-md',
  square: 'rounded-md aspect-square justify-center !px-0',
  pill: 'rounded-full',
};

// variant × tone class composition. Uses tokens from tokens.css where possible
// (.btn-ghost, .btn-primary, .btn-danger), inline styles for new combos.
const toneSolid: Record<ButtonTone, string> = {
  neutral:
    'bg-white/10 hover:bg-white/15 text-[rgba(255,255,255,0.92)] border border-white/5',
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
    'bg-white/[0.10] hover:bg-white/[0.14] text-[rgba(255,255,255,0.92)] border border-white/5',
  accent:
    'text-[#4A8BEA] border [background:rgba(var(--stash-accent-rgb),0.16)] [border-color:rgba(var(--stash-accent-rgb),0.28)] hover:[background:rgba(var(--stash-accent-rgb),0.24)]',
  success:
    'text-[color:var(--color-success-fg)] border border-[rgba(var(--color-success-rgb),0.28)] [background:rgba(var(--color-success-rgb),0.16)] hover:[background:rgba(var(--color-success-rgb),0.24)]',
  warning:
    'text-[color:var(--color-warning-fg)] border border-[rgba(var(--color-warning-rgb),0.28)] [background:rgba(var(--color-warning-rgb),0.16)] hover:[background:rgba(var(--color-warning-rgb),0.24)]',
  danger: 'btn-danger',
};

const toneGhost: Record<ButtonTone, string> = {
  neutral: 'btn-ghost t-primary',
  accent: 'text-[#4A8BEA] hover:bg-white/5',
  success: 'text-[color:var(--color-success-fg)] hover:bg-white/5',
  warning: 'text-[color:var(--color-warning-fg)] hover:bg-white/5',
  danger: 'text-[color:var(--color-danger-fg)] hover:bg-white/5',
};

const toneOutline: Record<ButtonTone, string> = {
  neutral:
    'border border-white/[0.06] hover:bg-white/5 text-[rgba(255,255,255,0.92)]',
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
    'inline-flex items-center whitespace-nowrap transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed ring-focus',
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
