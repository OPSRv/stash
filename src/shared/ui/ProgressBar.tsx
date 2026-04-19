type ProgressBarProps = {
  value: number; // 0..1
  paused?: boolean;
  size?: 'xs' | 'sm';
  className?: string;
  ariaLabel?: string;
};

const heightClass: Record<'xs' | 'sm', string> = {
  xs: 'h-1',
  sm: 'h-[3px]',
};

export const ProgressBar = ({
  value,
  paused = false,
  size = 'xs',
  className = '',
  ariaLabel,
}: ProgressBarProps) => {
  const clamped = Math.min(1, Math.max(0, value));
  const pct = (clamped * 100).toFixed(2);
  return (
    <div
      className={`${heightClass[size]} rounded-full overflow-hidden ${className}`}
      role="progressbar"
      aria-valuenow={Math.round(clamped * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={ariaLabel}
      style={{ background: 'rgba(255,255,255,0.08)' }}
    >
      <div
        className={`h-full rounded-full ${paused ? 'prog-fill-paused' : 'prog-fill'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
};
