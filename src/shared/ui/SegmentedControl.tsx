import type { ReactNode } from 'react';
import { Tooltip } from './Tooltip';

export type SegmentOption<T extends string = string> = {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
};

type SegmentedControlProps<T extends string> = {
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  className?: string;
  ariaLabel?: string;
};

const padding: Record<'sm' | 'md', string> = {
  sm: 'px-2 py-0.5',
  md: 'px-3 py-1',
};

export const SegmentedControl = <T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  className = '',
  ariaLabel,
}: SegmentedControlProps<T>) => (
  <div className={`seg flex text-meta font-medium ${className}`} role="radiogroup" aria-label={ariaLabel}>
    {options.map((opt) => {
      const active = opt.value === value;
      return (
        <Tooltip key={opt.value} label={opt.title}>
          <button
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={opt.title}
            disabled={opt.disabled}
            data-seg-title={opt.title}
            onClick={() => onChange(opt.value)}
            className={`rounded-[4px] inline-flex items-center gap-1.5 disabled:opacity-35 disabled:cursor-not-allowed ${padding[size]} ${active ? 'on' : ''}`}
          >
            {opt.icon}
            {opt.label}
          </button>
        </Tooltip>
      );
    })}
  </div>
);
