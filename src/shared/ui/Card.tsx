import type { MouseEvent, ReactNode } from 'react';

export type CardTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
export type CardPadding = 'none' | 'sm' | 'md' | 'lg';
export type CardElevation = 'flat' | 'raised';

type Props = {
  children: ReactNode;
  tone?: CardTone;
  padding?: CardPadding;
  elevation?: CardElevation;
  rounded?: 'md' | 'lg' | 'xl';
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  title?: string;
  className?: string;
  ariaLabel?: string;
};

const padClass: Record<CardPadding, string> = {
  none: '',
  sm: 'p-2',
  md: 'p-3',
  lg: 'p-4',
};

const roundedClass = {
  md: 'rounded-md',
  lg: 'rounded-lg',
  xl: 'rounded-xl',
} as const;

const toneClass: Record<CardTone, string> = {
  neutral: '',
  accent: 'stash-card--accent',
  success: 'stash-card--success',
  warning: 'stash-card--warning',
  danger: 'stash-card--danger',
};

export const Card = ({
  children,
  tone = 'neutral',
  padding = 'md',
  elevation = 'flat',
  rounded = 'lg',
  onClick,
  title,
  ariaLabel,
  className = '',
}: Props) => {
  const elev = elevation === 'raised' ? 'pane pane-elev' : 'stash-card--flat';
  const base = [
    'stash-card',
    elev,
    roundedClass[rounded],
    padClass[padding],
    toneClass[tone],
    onClick ? 'ring-focus cursor-pointer text-left w-full transition-colors' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} aria-label={ariaLabel} className={base}>
        {children}
      </button>
    );
  }
  return (
    <div title={title} aria-label={ariaLabel} className={base}>
      {children}
    </div>
  );
};
