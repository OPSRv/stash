import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';

type TooltipProps = {
  label?: string;
  children: ReactNode;
  /** Side to anchor the bubble. Defaults to 'top'. Use 'right'/'left' when the
   *  trigger sits near a horizontal edge of its container (e.g. a collapsed
   *  sidebar rail) — top/bottom bubbles clip there because they center on the
   *  trigger. */
  side?: 'top' | 'bottom' | 'left' | 'right';
};

/** CSS-only hover/focus tooltip. Decorates the child element in place — no
 *  wrapper element — so parent flex/grid layout (flex-1, w-full, shrink-0,
 *  etc.) keeps working. The child receives `tip tip-<side>` on its className
 *  and a hidden `<span role="tooltip">` bubble as a trailing child.
 *
 *  Children that cannot accept arbitrary DOM children (e.g. `<select>`,
 *  `<input>`, `<img>`) must be wrapped by the caller in a `<span>` first.
 */
export const Tooltip = ({ label, children, side = 'top' }: TooltipProps) => {
  if (!label || !isValidElement(children)) return <>{children}</>;
  const child = children as ReactElement<{ className?: string; children?: ReactNode }>;
  const className = [child.props.className ?? '', `tip tip-${side}`]
    .filter(Boolean)
    .join(' ');
  return cloneElement(
    child,
    { className },
    <>
      {child.props.children}
      <span role="tooltip" aria-hidden="true" className="tip-label">
        {label}
      </span>
    </>,
  );
};
