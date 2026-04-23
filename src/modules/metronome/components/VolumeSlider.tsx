interface VolumeSliderProps {
  value: number;
  onChange: (value: number) => void;
  label: string;
  testId?: string;
}

/// Compact percentage slider used in the Metronome controls row.
/// Track fill is driven by a CSS var so the gradient follows the value.
export const VolumeSlider = ({ value, onChange, label, testId }: VolumeSliderProps) => {
  const pct = Math.round(value * 100);
  return (
    <label className="flex flex-col gap-1" style={{ width: 92 }}>
      <span
        className="flex items-baseline justify-between t-tertiary"
        style={{ fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', fontWeight: 600 }}
      >
        <span>{label}</span>
        <span className="font-mono t-primary" style={{ fontSize: 11, letterSpacing: 0 }}>
          {pct}
        </span>
      </span>
      <input
        type="range"
        min={0}
        max={100}
        value={pct}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        data-testid={testId}
        aria-label={label}
        className="metro-slider"
        style={{ width: '100%', ['--metro-pct' as string]: `${pct}%` }}
      />
    </label>
  );
};
