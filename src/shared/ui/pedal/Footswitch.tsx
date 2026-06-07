import { useId, type ReactNode } from 'react';
import { Led } from './Led';

/** A true-metal stomp switch in the classic compact-pedal layout: a status LED
 *  riding above a round footswitch, with an engraved caption below. The metal —
 *  brushed collar, three mounting bolts, domed cap — is a generated SVG so it
 *  reads as machined hardware and stays crisp at any DPI. The `<button>` is the
 *  hit target, so it remains fully keyboard- and screen-reader-accessible. The
 *  SVG only paints; the press dent is the button's CSS transform. Shared by the
 *  Metronome and Tuner. */

type Props = {
  onClick: () => void;
  /** Engraved caption under the switch (PLAY / STOP / TAP / LIVE …). */
  caption: string;
  /** Accessible name (may differ from the caption). */
  ariaLabel: string;
  /** Glyph or short text shown on the cap. */
  children: ReactNode;
  /** Lit + breathing LED above the switch. */
  lit?: boolean;
  /** Reflected on the cap glyph and on `aria-pressed`. */
  active?: boolean;
  testId?: string;
};

/** The machined metal body, drawn behind the glyph. */
const StompMetal = ({ on }: { on: boolean }) => {
  const uid = useId().replace(/:/g, '');
  // three mounting bolts at 90° / 210° / 330°.
  const bolts = [90, 210, 330].map((deg) => {
    const a = (deg * Math.PI) / 180;
    return { x: 30 + 23 * Math.cos(a), y: 30 + 23 * Math.sin(a) };
  });
  return (
    <svg viewBox="0 0 60 60" className="pedal-stomp-metal" aria-hidden="true">
      <defs>
        <radialGradient id={`${uid}-collar`} cx="38%" cy="30%" r="78%">
          <stop offset="0%" stopColor="#9aa6b6" />
          <stop offset="46%" stopColor="#5b6573" />
          <stop offset="100%" stopColor="#2c333d" />
        </radialGradient>
        <radialGradient id={`${uid}-cap`} cx="40%" cy="30%" r="80%">
          <stop offset="0%" stopColor="#2b323c" />
          <stop offset="52%" stopColor="#1a1f26" />
          <stop offset="100%" stopColor="#0c0f14" />
        </radialGradient>
      </defs>

      {/* collar nut */}
      <circle cx="30" cy="30" r="29" fill={`url(#${uid}-collar)`} stroke="#05070a" strokeWidth="1" />
      {/* fine knurl on the collar */}
      <g stroke="rgba(0,0,0,0.35)" strokeWidth="0.6">
        {Array.from({ length: 36 }, (_, i) => {
          const a = (i / 36) * 2 * Math.PI;
          return (
            <line
              key={i}
              x1={30 + 26 * Math.cos(a)}
              y1={30 + 26 * Math.sin(a)}
              x2={30 + 28.5 * Math.cos(a)}
              y2={30 + 28.5 * Math.sin(a)}
            />
          );
        })}
      </g>
      {/* mounting bolts */}
      {bolts.map((b, i) => (
        <g key={i}>
          <circle cx={b.x} cy={b.y} r="2.4" fill="#11151b" />
          <circle cx={b.x} cy={b.y} r="1.7" fill="#3a4350" stroke="#0a0d11" strokeWidth="0.4" />
          <circle cx={b.x - 0.5} cy={b.y - 0.6} r="0.6" fill="rgba(255,255,255,0.4)" />
        </g>
      ))}
      {/* domed cap you press */}
      <circle cx="30" cy="30" r="19" fill={`url(#${uid}-cap)`} stroke="#05070a" strokeWidth="1" />
      <circle
        cx="30"
        cy="30"
        r="18.5"
        fill="none"
        stroke={on ? 'rgba(74,163,255,0.55)' : 'rgba(255,255,255,0.10)'}
        strokeWidth="1"
      />
      {/* cap sheen */}
      <ellipse cx="25" cy="22" rx="9" ry="5" fill="rgba(255,255,255,0.10)" />
    </svg>
  );
};

export const Footswitch = ({ onClick, caption, ariaLabel, children, lit = false, active, testId }: Props) => (
  <div className="flex flex-col items-center gap-1.5">
    <Led size={9} on={lit} color="blue" className={lit ? 'pedal-stomp-led-on' : undefined} />
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={active}
      data-on={active}
      data-testid={testId}
      className="pedal-stomp"
    >
      <StompMetal on={!!active} />
      <span className="pedal-stomp-glyph">{children}</span>
    </button>
    <span className="pedal-stomp-cap">{caption}</span>
  </div>
);
