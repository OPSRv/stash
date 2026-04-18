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
    className="relative w-[34px] h-[20px] rounded-full transition"
    style={{ background: checked ? '#2F7AE5' : 'rgba(255,255,255,0.12)' }}
  >
    <span
      className="absolute top-[2px] w-4 h-4 bg-white rounded-full shadow transition-[left]"
      style={{ left: checked ? 16 : 2 }}
    />
  </button>
);
