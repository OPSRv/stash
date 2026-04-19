type ToggleProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
};

export const Toggle = ({ checked, onChange, label }: ToggleProps) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    onClick={() => onChange(!checked)}
    className="relative w-[34px] h-[20px] rounded-full ring-focus transition-colors duration-150"
    style={{
      background: checked ? 'var(--stash-accent)' : 'var(--color-surface-muted)',
    }}
  >
    <span
      className="absolute top-[2px] w-4 h-4 bg-white rounded-full transition-[left] duration-150"
      style={{ left: checked ? 16 : 2, boxShadow: 'var(--shadow-sm)' }}
    />
  </button>
);
