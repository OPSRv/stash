interface VolumeSliderProps {
  value: number;
  onChange: (value: number) => void;
  label: string;
  testId?: string;
}

/// Compact percentage slider used in the Metronome controls row.
/// Name is specific (VolumeSlider) so the shared-ui `Slider` primitive, if
/// one is added later, doesn't collide.
export const VolumeSlider = ({ value, onChange, label, testId }: VolumeSliderProps) => {
  const pct = Math.round(value * 100);
  return (
    <label className="flex flex-col gap-0.5" style={{ width: 76 }}>
      <span
        className="flex items-baseline justify-between t-tertiary"
        style={{ fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}
      >
        <span>{label}</span>
        <span className="font-mono">{pct}</span>
      </span>
      <input
        type="range"
        min={0}
        max={100}
        value={pct}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        data-testid={testId}
        aria-label={label}
        className="metronome-slider"
        style={{ width: '100%' }}
      />
    </label>
  );
};
