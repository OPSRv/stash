import type { ReactNode } from 'react';

/** One row of the flat setup sheet: an uppercase caption pinned to the left,
 *  its control(s) on the right. Sibling rows are hair-lined apart by CSS
 *  (`.metro-row + .metro-row`), so rows from different components
 *  (Controls / Levels / ExtrasRow) still divide cleanly as long as they share
 *  one parent. `align="start"` top-aligns the body for tall rows (Trainer). */
type SetupRowProps = {
  label: string;
  children: ReactNode;
  align?: 'center' | 'start';
};

export const SetupRow = ({ label, children, align = 'center' }: SetupRowProps) => (
  <div className="metro-row" data-align={align}>
    <span className="metro-row-label">{label}</span>
    <div className="metro-row-body">{children}</div>
  </div>
);
