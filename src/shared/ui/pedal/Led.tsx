import { useId } from 'react';

/** A glassy panel LED, rendered as SVG so it domes and blooms like a real
 *  indicator rather than a flat CSS dot. Used for the metronome's beat row,
 *  the footswitch status light, and the tuner's string/meter segments. Purely
 *  presentational (`aria-hidden`) — the interactive element is always the
 *  wrapping button/control. */

export type LedColor = 'blue' | 'green' | 'amber';

type Ramp = { core: string; mid: string; edge: string; bloom: string };

const RAMPS: Record<LedColor, Ramp> = {
  blue: { core: '#d4ebff', mid: '#4aa3ff', edge: '#2f7fd6', bloom: 'rgba(74,163,255,0.9)' },
  green: { core: '#aef7d5', mid: '#3ddc97', edge: '#1f9c68', bloom: 'rgba(61,220,151,0.9)' },
  amber: { core: '#ffd9a0', mid: '#f5a623', edge: '#b8780f', bloom: 'rgba(245,166,35,0.9)' },
};

type Props = {
  /** Diameter in px. */
  size?: number;
  /** Lit (emitting) vs dark. */
  on?: boolean;
  color?: LedColor;
  /** Draw a coloured retaining ring even while dark — marks a "special" slot
   *  (e.g. an accented downbeat). */
  ring?: boolean;
  className?: string;
};

export const Led = ({ size = 15, on = false, color = 'blue', ring = false, className }: Props) => {
  const uid = useId().replace(/:/g, '');
  const ramp = RAMPS[color];

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      style={{ display: 'block', overflow: 'visible' }}
    >
      <defs>
        <radialGradient id={`${uid}-off`} cx="40%" cy="34%" r="72%">
          <stop offset="0%" stopColor="#1c2530" />
          <stop offset="70%" stopColor="#0a0e13" />
        </radialGradient>
        <radialGradient id={`${uid}-on`} cx="42%" cy="36%" r="68%">
          <stop offset="0%" stopColor={ramp.core} />
          <stop offset="58%" stopColor={ramp.mid} />
          <stop offset="100%" stopColor={ramp.edge} />
        </radialGradient>
        <filter id={`${uid}-bloom`} x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="2.4" />
        </filter>
      </defs>

      {/* outer bloom halo when lit */}
      {on && <circle cx="12" cy="12" r="8" fill={ramp.bloom} filter={`url(#${uid}-bloom)`} opacity="0.85" />}

      {/* lens */}
      <circle
        cx="12"
        cy="12"
        r="8"
        fill={on ? `url(#${uid}-on)` : `url(#${uid}-off)`}
        stroke={on ? 'rgba(255,255,255,0.45)' : ring ? ramp.mid : 'rgba(0,0,0,0.8)'}
        strokeWidth={ring && !on ? 1.4 : 0.8}
      />
      {/* glass highlight */}
      <ellipse cx="10" cy="9.4" rx="3.2" ry="2.1" fill="rgba(255,255,255,0.4)" opacity={on ? 0.85 : 0.3} />
    </svg>
  );
};
