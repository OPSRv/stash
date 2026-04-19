import type { ReactNode } from 'react';

export type SegmentOption<T extends string = string> = {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
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
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={active}
          onClick={() => onChange(opt.value)}
          className={`rounded-md inline-flex items-center gap-1.5 ${padding[size]} ${active ? 'on' : ''}`}
        >
          {opt.icon}
          {opt.label}
        </button>
      );
    })}
  </div>
);
