import type { ReactNode } from 'react';

type TooltipProps = {
  label?: string;
  children: ReactNode;
  /** Vertical side to anchor the bubble. Defaults to 'top'. */
  side?: 'top' | 'bottom';
};

/** CSS-only hover/focus tooltip. Renders the trigger as a positioned wrapper
 *  and a small bubble that fades in after a short delay. When `label` is
 *  empty the wrapper is skipped entirely. */
export const Tooltip = ({ label, children, side = 'top' }: TooltipProps) => {
  if (!label) return <>{children}</>;
  return (
    <span className={`tip tip-${side}`}>
      {children}
      <span role="tooltip" className="tip-label">
        {label}
      </span>
    </span>
  );
};
