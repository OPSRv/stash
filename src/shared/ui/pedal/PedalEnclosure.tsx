import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/* The cast-aluminium stompbox body, rendered as a single generated SVG plate
 * behind the DOM controls. Replaces the old CSS gradient/box-shadow enclosure
 * so the whole face reads as one milled piece of metal: a bevelled rounded
 * body, a faint sand-cast grain, four sunk Phillips bolts, and an accent rim
 * that glows while the unit is "live".
 *
 * The SVG is drawn at the element's exact pixel size (tracked with a
 * ResizeObserver) and a matching `viewBox`, so strokes stay 1px-crisp and the
 * bolts stay perfectly round at any panel size — a `preserveAspectRatio="none"`
 * stretch would smear them into ovals. Children render in a layer above the
 * plate, exactly as before. Shared by the Metronome and Tuner. */

type Props = {
  children: ReactNode;
  /** Extra classes on the root (layout: flex/min-h-full/etc.). */
  className?: string;
  /** Corner radius of the casting, px. */
  radius?: number;
  /** Lights the accent rim + warms the body when the unit is running. */
  playing?: boolean;
  /** Slot angles for the four corner bolts, [tl, tr, bl, br]. */
  boltAngles?: [number, number, number, number];
  /** Set to false to hide the corner bolts (e.g. for a flush-panel look). */
  showBolts?: boolean;
  style?: CSSProperties;
  'data-testid'?: string;
};

const BOLT_INSET = 15; // bolt centre offset from each corner, px
const BOLT_R = 6;

/** One Phillips bolt sunk into the casting, drawn at (cx, cy). */
const Bolt = ({ cx, cy, angle }: { cx: number; cy: number; angle: number }) => (
  <g filter="url(#pedal-bolt-shadow)">
    {/* recessed well */}
    <circle cx={cx} cy={cy} r={BOLT_R + 1} fill="#0a0d11" />
    {/* metal head */}
    <circle cx={cx} cy={cy} r={BOLT_R} fill="url(#pedal-bolt-metal)" stroke="#05070a" strokeWidth="0.5" />
    {/* top sheen */}
    <ellipse cx={cx - 1.4} cy={cy - 2} rx="3" ry="1.7" fill="rgba(255,255,255,0.22)" />
    {/* cross slot */}
    <g transform={`rotate(${angle} ${cx} ${cy})`} stroke="#0a0d11" strokeWidth="1.1" strokeLinecap="round">
      <line x1={cx} y1={cy - 4} x2={cx} y2={cy + 4} />
      <line x1={cx - 4} y1={cy} x2={cx + 4} y2={cy} />
    </g>
  </g>
);

export const PedalEnclosure = ({
  children,
  className = '',
  radius = 14,
  playing = false,
  boltAngles = [18, -32, -12, 40],
  showBolts = true,
  style,
  'data-testid': testId,
}: Props) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [{ w, h }, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ready = w > 0 && h > 0;
  const r = radius;
  const inset = 0.5;

  return (
    <div
      ref={ref}
      className="pedal-enclosure"
      style={{ borderRadius: r, ...style }}
      data-playing={playing}
      data-testid={testId}
    >
      {ready && (
        <svg
          className="pedal-enclosure-plate"
          width={w}
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="pedal-body" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2a323c" />
              <stop offset="16%" stopColor="#1a2027" />
              <stop offset="58%" stopColor="#12161c" />
              <stop offset="100%" stopColor="#0b0e13" />
            </linearGradient>
            <radialGradient id="pedal-sheen" cx="30%" cy="-12%" r="80%">
              <stop offset="0%" stopColor="rgba(74,163,255,0.10)" />
              <stop offset="52%" stopColor="rgba(74,163,255,0)" />
            </radialGradient>
            <radialGradient id="pedal-bolt-metal" cx="38%" cy="32%" r="72%">
              <stop offset="0%" stopColor="#aab4c2" />
              <stop offset="45%" stopColor="#6b7480" />
              <stop offset="100%" stopColor="#2a3038" />
            </radialGradient>
            <filter id="pedal-grain">
              <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" result="n" />
              <feColorMatrix in="n" type="saturate" values="0" />
            </filter>
            <filter id="pedal-bolt-shadow" x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow dx="0" dy="1" stdDeviation="0.8" floodColor="#000" floodOpacity="0.6" />
            </filter>
            {playing && (
              <filter id="pedal-rim-glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="3" />
              </filter>
            )}
          </defs>

          {/* cast body */}
          <rect x={inset} y={inset} width={w - 1} height={h - 1} rx={r} fill="url(#pedal-body)" />
          {/* cool top sheen rolling off the casting */}
          <rect x={inset} y={inset} width={w - 1} height={h - 1} rx={r} fill="url(#pedal-sheen)" />
          {/* sand-cast grain */}
          <rect
            x={inset}
            y={inset}
            width={w - 1}
            height={h - 1}
            rx={r}
            filter="url(#pedal-grain)"
            opacity="0.05"
          />
          {/* milled top edge + chamfer */}
          <rect x={inset} y={inset} width={w - 1} height={h - 1} rx={r} fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth="1" />
          <rect x={1.5} y={1.5} width={w - 3} height={h - 3} rx={r - 1} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
          {/* top-lip highlight */}
          <path
            d={`M ${r} 2 H ${w - r}`}
            fill="none"
            stroke="rgba(255,255,255,0.12)"
            strokeWidth="1"
            strokeLinecap="round"
          />

          {/* accent rim while live */}
          {playing && (
            <>
              <rect
                x={1.5}
                y={1.5}
                width={w - 3}
                height={h - 3}
                rx={r - 1}
                fill="none"
                stroke="rgba(74,163,255,0.5)"
                strokeWidth="1.2"
                filter="url(#pedal-rim-glow)"
              />
              <rect
                x={1.5}
                y={1.5}
                width={w - 3}
                height={h - 3}
                rx={r - 1}
                fill="none"
                stroke="rgba(74,163,255,0.32)"
                strokeWidth="1"
              />
            </>
          )}

          {/* corner bolts */}
          {showBolts && (
            <>
              <Bolt cx={BOLT_INSET} cy={BOLT_INSET} angle={boltAngles[0]} />
              <Bolt cx={w - BOLT_INSET} cy={BOLT_INSET} angle={boltAngles[1]} />
              <Bolt cx={BOLT_INSET} cy={h - BOLT_INSET} angle={boltAngles[2]} />
              <Bolt cx={w - BOLT_INSET} cy={h - BOLT_INSET} angle={boltAngles[3]} />
            </>
          )}
        </svg>
      )}
      <div className={`pedal-enclosure-content ${className}`}>{children}</div>
    </div>
  );
};
