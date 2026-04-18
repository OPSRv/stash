import type { ReactNode } from 'react';

type RowProps = {
  primary: ReactNode;
  secondary?: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  active?: boolean;
  pinned?: boolean;
  onSelect?: () => void;
};

export const Row = ({
  primary,
  secondary,
  icon,
  meta,
  active = false,
  pinned = false,
  onSelect,
}: RowProps) => {
  const classes = [
    'mx-2 my-0.5 rounded-lg flex items-center gap-3 px-2.5 py-2 cursor-pointer',
    active ? 'row-active' : pinned ? 'row-pinned' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      role="option"
      aria-selected={active ? 'true' : 'false'}
      onClick={onSelect}
      className={classes}
    >
      {icon && <div className="w-7 h-7 rounded-md flex items-center justify-center shrink-0">{icon}</div>}
      <div className="flex-1 min-w-0">
        <div className="t-primary text-body truncate">{primary}</div>
        {secondary && <div className="t-tertiary text-meta truncate">{secondary}</div>}
      </div>
      {meta && <div className="flex items-center gap-2 shrink-0">{meta}</div>}
    </div>
  );
};
