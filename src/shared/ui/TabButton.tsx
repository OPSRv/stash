type TabButtonProps = {
  label: string;
  shortcutHint?: string;
  active: boolean;
  onClick: () => void;
};

export const TabButton = ({ label, shortcutHint, active, onClick }: TabButtonProps) => {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      title={shortcutHint ? `${label} (${shortcutHint})` : label}
      className={`px-2 py-1 rounded-md text-meta font-medium flex items-center gap-1.5 cursor-pointer ${
        active ? 't-primary' : 't-secondary'
      }`}
      style={active ? { background: 'rgba(255,255,255,0.06)' } : undefined}
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
