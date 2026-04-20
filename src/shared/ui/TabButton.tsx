import { forwardRef, type ReactNode } from 'react';

type TabButtonProps = {
  label: string;
  icon?: ReactNode;
  shortcutHint?: string;
  active: boolean;
  onClick: () => void;
  onHover?: () => void;
};

export const TabButton = forwardRef<HTMLButtonElement, TabButtonProps>(
  ({ label, icon, shortcutHint, active, onClick, onHover }, ref) => (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      onMouseEnter={onHover}
      onFocus={onHover}
      aria-current={active ? 'true' : undefined}
      title={shortcutHint ? `${label} (${shortcutHint})` : label}
      className={`relative h-7 px-2.5 rounded-md text-meta font-medium inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer ring-focus-sm transition-colors duration-150 ${
        active ? 't-primary' : 't-secondary hover:t-primary'
      }`}
    >
      {icon && <span className="inline-flex shrink-0">{icon}</span>}
      {label}
    </button>
  ),
);
TabButton.displayName = 'TabButton';
