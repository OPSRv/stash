import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

type Props = {
  children: ReactNode;
  tone?: BadgeTone;
  /** Override foreground color. Used by PlatformBadge for brand colors. */
  color?: string;
  /** Override background. Used alongside `color`. */
  bg?: string;
  className?: string;
  title?: string;
};

export const Badge = ({ children, tone = 'neutral', color, bg, className = '', title }: Props) => {
  const hasOverride = color != null || bg != null;
  const toneClass = hasOverride ? '' : `stash-badge--${tone}`;
  const style = hasOverride ? { color, background: bg } : undefined;
  return (
    <span
      title={title}
      className={`stash-badge ${toneClass} ${className}`.trim()}
      style={style}
    >
      {children}
    </span>
  );
};
