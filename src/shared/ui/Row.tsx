import type { ReactNode } from 'react';

type RowProps = {
  primary: ReactNode;
  secondary?: ReactNode;
  icon?: ReactNode;
  iconTint?: string;
  iconColor?: string;
  meta?: ReactNode;
  actions?: ReactNode;
  active?: boolean;
  pinned?: boolean;
  onSelect?: (e?: React.MouseEvent) => void;
  selected?: boolean;
  className?: string;
};

export const Row = ({
  primary,
  secondary,
  icon,
  iconTint = 'rgba(255,255,255,0.06)',
  iconColor = 'rgba(255,255,255,0.85)',
  meta,
  actions,
  active = false,
  pinned = false,
  onSelect,
  selected = false,
  className = '',
}: RowProps) => {
  const classes = [
    'group row-base mx-2 my-0.5 rounded-lg flex items-center gap-3 px-2.5 py-2 cursor-pointer select-none',
    selected ? 'row-selected' : '',
    active ? 'row-active' : pinned ? 'row-pinned' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      role="option"
      aria-selected={active ? 'true' : 'false'}
      onClick={(e) => onSelect?.(e)}
      className={classes}
    >
      {icon && (
        <div
          className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 overflow-hidden"
          style={{ background: iconTint, color: iconColor }}
        >
          {icon}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="t-primary text-body truncate">{primary}</div>
        {secondary && <div className="t-tertiary text-meta truncate">{secondary}</div>}
      </div>
      {actions && (
        <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
          {actions}
        </div>
      )}
      {meta && <div className="flex items-center gap-2 shrink-0">{meta}</div>}
    </div>
  );
};
