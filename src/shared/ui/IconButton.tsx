import type { MouseEvent, ReactNode } from 'react';

type IconButtonProps = {
  onClick: (e: MouseEvent) => void;
  children: ReactNode;
  title?: string;
  tone?: 'default' | 'danger';
  stopPropagation?: boolean;
};

export const IconButton = ({
  onClick,
  children,
  title,
  tone = 'default',
  stopPropagation = true,
}: IconButtonProps) => {
  const toneClass = tone === 'danger' ? 't-secondary hover:text-red-400' : 't-secondary hover:t-primary';
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={(e) => {
        if (stopPropagation) e.stopPropagation();
        onClick(e);
      }}
      className={`w-6 h-6 rounded-md flex items-center justify-center bg-white/[0.04] hover:bg-white/[0.08] transition-colors ${toneClass}`}
    >
      {children}
    </button>
  );
};
