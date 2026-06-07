import { forwardRef, type ReactNode } from 'react';

type TabButtonProps = {
  label: string;
  icon?: ReactNode;
  active: boolean;
  onClick: () => void;
  onHover?: () => void;
};

export const TabButton = forwardRef<HTMLButtonElement, TabButtonProps>(
  ({ label, icon, active, onClick, onHover }, ref) => {
    // Labels are always visible — the header is a horizontally-scrollable rail
    // with flanking arrow buttons (see PopupShell), so we never collapse a tab
    // to icon-only to make everything fit. `shrink-0` keeps each tab at its
    // natural width instead of squeezing labels when the rail overflows.
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        onMouseEnter={onHover}
        onFocus={onHover}
        aria-current={active ? 'true' : undefined}
        aria-label={label}
        className={`relative h-7 px-2.5 rounded-md text-meta font-medium inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap cursor-pointer ring-focus-sm transition-colors duration-150 ${
          active ? 't-primary' : 't-secondary hover:t-primary'
        }`}
      >
        {icon && (
          <span
            className={`inline-flex shrink-0 transition-transform duration-150 motion-reduce:transition-none ${
              active ? 'scale-110' : 'scale-100'
            }`}
          >
            {icon}
          </span>
        )}
        <span>{label}</span>
      </button>
    );
  },
);
TabButton.displayName = 'TabButton';
