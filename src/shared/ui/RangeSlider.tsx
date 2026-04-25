import type { CSSProperties } from 'react';
import './RangeSlider.css';

export interface RangeSliderProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  showFill?: boolean;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  id?: string;
  'data-testid'?: string;
}

export const RangeSlider = ({
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  label,
  showFill = true,
  disabled,
  className,
  style: styleProp,
  id,
  'data-testid': dataTestId,
}: RangeSliderProps) => {
  const range = max - min;
  const rawPct = range > 0 ? ((value - min) / range) * 100 : 0;
  const pct = Math.min(100, Math.max(0, rawPct));

  const fillStyle = showFill
    ? ({ ['--stash-range-pct' as string]: `${pct}%` } as CSSProperties)
    : undefined;

  const style: CSSProperties | undefined =
    fillStyle != null || styleProp != null
      ? { ...fillStyle, ...styleProp }
      : undefined;

  return (
    <input
      type="range"
      id={id}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => onChange(Number(e.currentTarget.value))}
      data-testid={dataTestId}
      className={[
        'stash-range ring-focus',
        !showFill ? 'stash-range--no-fill' : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={style}
    />
  );
};
