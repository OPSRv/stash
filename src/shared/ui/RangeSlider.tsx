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
  /// Comma-separated RGB triple (e.g. `"236, 72, 153"`) that replaces
  /// the global accent for *this* slider only. Used by per-stem volume
  /// sliders in the Stems mixer where each lane carries its own hue.
  /// When omitted, the slider tracks `--stash-accent-rgb`.
  colorRgb?: string;
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
  colorRgb,
}: RangeSliderProps) => {
  const range = max - min;
  const rawPct = range > 0 ? ((value - min) / range) * 100 : 0;
  const pct = Math.min(100, Math.max(0, rawPct));

  const fillStyle: CSSProperties = {};
  if (showFill) {
    (fillStyle as Record<string, string>)['--stash-range-pct'] = `${pct}%`;
  }
  // Per-instance accent override. Scoped via inline custom property
  // so the existing CSS continues to read `rgba(var(--stash-accent-rgb), …)`
  // without per-stem rules.
  if (colorRgb) {
    (fillStyle as Record<string, string>)['--stash-accent-rgb'] = colorRgb;
  }

  const style: CSSProperties | undefined =
    Object.keys(fillStyle).length > 0 || styleProp != null
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
