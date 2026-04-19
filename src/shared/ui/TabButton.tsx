type TabButtonProps = {
  label: string;
  shortcutHint?: string;
  active: boolean;
  onClick: () => void;
  onHover?: () => void;
};

export const TabButton = ({
  label,
  shortcutHint,
  active,
  onClick,
  onHover,
}: TabButtonProps) => {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onHover}
      onFocus={onHover}
      aria-current={active ? 'true' : undefined}
      title={shortcutHint ? `${label} (${shortcutHint})` : label}
      className={`h-7 px-2.5 rounded-md text-meta font-medium flex items-center gap-1.5 cursor-pointer ring-focus-sm transition-colors duration-150 ${
        active
          ? 't-primary bg-[var(--color-surface-raised)]'
          : 't-secondary hover:bg-[var(--color-surface-raised)]'
      }`}
    >
      {active && shortcutHint && (
        <span className="kbd" aria-hidden="true">
          {shortcutHint}
        </span>
      )}
      {label}
    </button>
  );
};
