import { RangeSlider } from '../../../shared/ui/RangeSlider';

interface VolumeSliderProps {
  value: number;
  onChange: (value: number) => void;
  label: string;
  testId?: string;
}

/// Compact percentage slider used in the Metronome controls row.
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
      <RangeSlider
        value={pct}
        onChange={(v) => onChange(v / 100)}
        min={0}
        max={100}
        label={label}
        data-testid={testId}
        style={{ width: '100%' }}
      />
    </label>
  );
};
