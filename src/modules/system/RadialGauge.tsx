import type { ReactNode } from 'react';
import { accent } from '../../shared/theme/accent';

type Props = {
  /// 0..1 filled arc ratio.
  value: number;
  size?: number;
  thickness?: number;
  /// Gradient stops (inner → outer of the arc). Falls back to the app accent.
  gradient?: [string, string];
  /// Glow behind the arc for the CleanMyMac-esque sheen.
  glow?: string;
  label: ReactNode;
  sublabel?: ReactNode;
};

export const RadialGauge = ({
  value,
  size = 96,
  thickness = 8,
  gradient,
  glow,
  label,
  sublabel,
}: Props) => {
  const clamped = Math.max(0, Math.min(1, value));
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = circumference * clamped;
  const id = `rg-${Math.random().toString(36).slice(2, 8)}`;
  const [c0, c1] = gradient ?? [accent(1), accent(0.35)];
  const glowColor = glow ?? accent(0.35);
  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <div
        aria-hidden
        className="absolute inset-2 rounded-full"
        style={{
          background: `radial-gradient(closest-side, ${glowColor}, transparent 70%)`,
          filter: 'blur(6px)',
          opacity: 0.85,
        }}
      />
      <svg width={size} height={size} className="relative" aria-hidden>
        <defs>
          <linearGradient id={id} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={c0} />
            <stop offset="100%" stopColor={c1} />
          </linearGradient>
        </defs>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={thickness}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={`url(#${id})`}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference - dash}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dasharray 400ms ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <div className="t-primary font-semibold text-title leading-tight">{label}</div>
        {sublabel && (
          <div className="t-tertiary text-[10px] leading-tight mt-0.5">{sublabel}</div>
        )}
      </div>
    </div>
  );
};
