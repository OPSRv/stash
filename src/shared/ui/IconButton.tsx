import type { MouseEvent, ReactNode } from 'react';
import { Tooltip } from './Tooltip';

type IconButtonProps = {
  onClick: (e: MouseEvent) => void;
  children: ReactNode;
  title?: string;
  tone?: 'default' | 'danger';
  stopPropagation?: boolean;
  disabled?: boolean;
  /** Tooltip placement relative to the button. Defaults to `bottom` because
   *  most icon buttons live near the top of a scroll container, and a
   *  top-placed tooltip would clip behind the tabs bar above. */
  tooltipSide?: 'top' | 'bottom' | 'left' | 'right';
};

export const IconButton = ({
  onClick,
  children,
  title,
  tone = 'default',
  stopPropagation = true,
  disabled = false,
  tooltipSide = 'bottom',
}: IconButtonProps) => {
  const toneClass = tone === 'danger' ? 't-primary hover:text-red-400' : 't-primary hover:t-primary';
  return (
    <Tooltip label={title} side={tooltipSide}>
      <button
        type="button"
        aria-label={title}
        disabled={disabled}
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          onClick(e);
        }}
        className={`ring-focus w-6 h-6 rounded-md flex items-center justify-center bg-white/[0.04] hover:bg-white/[0.08] transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white/[0.04] ${toneClass}`}
      >
        {children}
      </button>
    </Tooltip>
  );
};
