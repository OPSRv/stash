import type { MouseEventHandler, ReactNode } from 'react';

type ListItemRowProps = {
  title: ReactNode;
  /// Optional second line under the title (path, date, subtitle).
  meta?: ReactNode;
  /// Leading slot — checkbox, avatar, or icon. Rendered with `shrink-0`.
  leading?: ReactNode;
  /// Right-side slot — size, action buttons, badges. Laid out inline with
  /// `gap-3` so callers can drop a stack of children directly.
  trailing?: ReactNode;
  selected?: boolean;
  onClick?: MouseEventHandler<HTMLLIElement>;
  className?: string;
};

/// Common `<li>` row used by every system panel's list view. Replaces
/// ~13 near-identical `<li className="px-4 py-2 flex items-center gap-3">`
/// blocks that previously lived inline in each panel.
export const ListItemRow = ({
  title,
  meta,
  leading,
  trailing,
  selected,
  onClick,
  className,
}: ListItemRowProps) => {
  const interactive = onClick != null;
  return (
    <li
      className={`px-4 py-2 flex items-center gap-3 ${
        interactive
          ? `cursor-pointer transition-colors ${
              selected ? '[background:var(--bg-hover)]' : 'hover:[background:var(--bg-hover)]'
            }`
          : ''
      } ${className ?? ''}`}
      onClick={onClick}
    >
      {leading && <div className="shrink-0">{leading}</div>}
      <div className="min-w-0 flex-1">
        <div className="t-primary text-body font-medium truncate">{title}</div>
        {meta && <div className="t-tertiary text-meta truncate">{meta}</div>}
      </div>
      {trailing}
    </li>
  );
};
