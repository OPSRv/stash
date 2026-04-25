import { RangeSlider } from '../shared/ui/RangeSlider';

interface SliderFieldProps {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
  display: string;
}

export const SliderField = ({
  label,
  description,
  value,
  min,
  max,
  step,
  onChange,
  display,
}: SliderFieldProps) => (
  <div className="py-3">
    <div className="flex items-baseline justify-between gap-3 mb-1.5">
      <div className="min-w-0">
        <div className="t-primary text-body font-medium">{label}</div>
        <div className="t-tertiary text-meta truncate">{description}</div>
      </div>
      <span className="t-secondary text-meta font-mono shrink-0">{display}</span>
    </div>
    <RangeSlider
      label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={onChange}
      className="w-full"
    />
  </div>
);
