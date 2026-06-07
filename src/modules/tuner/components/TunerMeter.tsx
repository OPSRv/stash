/* The Boss TU-3 style cents meter: a fanned row of LED segments inside the
 * display window. The centre segments mark the in-tune zone; as the pitch
 * drifts flat (left) or sharp (right) the lit "head" segment slides toward that
 * edge and the bar fills from the centre out, exactly like the hardware's
 * needle of light. Green when in tune, amber while off. Pure presentational
 * SVG driven by the live reading. */

type Props = {
  /** Signed cents from the target, clamped to ±50 for display. */
  cents: number;
  /** A pitch is currently detected. */
  active: boolean;
  /** Within the in-tune window. */
  inTune: boolean;
};

const SEGMENTS = 21;
const CENTER = (SEGMENTS - 1) / 2; // index 10
const MAX_CENTS = 50;

const VIEW_W = 240;
const VIEW_H = 84;
const BASE_Y = 60; // baseline the bars grow up from
const PAD_X = 16;

const GREEN = { mid: '#3ddc97', bloom: 'rgba(61,220,151,0.95)' };
const AMBER = { mid: '#f5a623', bloom: 'rgba(245,166,35,0.95)' };

export const TunerMeter = ({ cents, active, inTune }: Props) => {
  const clamped = Math.max(-MAX_CENTS, Math.min(MAX_CENTS, cents));
  // Continuous head position in segment space, 0..SEGMENTS-1.
  const headPos = active ? CENTER + (clamped / MAX_CENTS) * CENTER : CENTER;
  const tone = inTune ? GREEN : AMBER;

  const step = (VIEW_W - PAD_X * 2) / (SEGMENTS - 1);
  const segW = step * 0.62;

  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="tuner-meter w-full" aria-hidden="true">
      <defs>
        <filter id="tuner-seg-bloom" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2" />
        </filter>
        <linearGradient id="tuner-seg-on" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor={tone.mid} stopOpacity="0.55" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0.95" />
        </linearGradient>
      </defs>

      {Array.from({ length: SEGMENTS }, (_, i) => {
        const dist = Math.abs(i - CENTER);
        const x = PAD_X + i * step;
        // Fan profile — tallest at centre, shortest at the edges.
        const h = 12 + (1 - dist / CENTER) * 22;
        const y = BASE_Y - h;
        const isCenterZone = dist <= 1;

        // Lit if the segment lies between the centre and the head (a filling
        // bar), or it is the in-tune centre marker.
        const lo = Math.min(CENTER, headPos);
        const hi = Math.max(CENTER, headPos);
        const lit = active && i >= Math.floor(lo) && i <= Math.ceil(hi);
        const isHead = active && Math.round(headPos) === i;
        // Centre keeps a permanent dim-green pilot.
        const pilot = isCenterZone;

        const segTone = isCenterZone && (inTune || !active) ? GREEN : tone;
        const opacity = lit ? (isHead ? 1 : 0.78) : pilot ? 0.22 : 0.12;

        return (
          <g key={i} opacity={opacity}>
            {(lit || (pilot && inTune)) && (
              <rect
                x={x - segW / 2 - 1}
                y={y - 1}
                width={segW + 2}
                height={h + 2}
                rx={3}
                fill={segTone.bloom}
                filter="url(#tuner-seg-bloom)"
                opacity="0.7"
              />
            )}
            <rect
              x={x - segW / 2}
              y={y}
              width={segW}
              height={h}
              rx={2.5}
              fill={lit ? `url(#tuner-seg-on)` : '#16202b'}
              stroke={lit ? segTone.mid : 'rgba(255,255,255,0.05)'}
              strokeWidth={lit ? 0.8 : 0.6}
            />
          </g>
        );
      })}

      {/* ♭ / centre / ♯ engraving under the meter */}
      <text x={PAD_X} y={VIEW_H - 6} fill="#4f7196" fontSize="13" fontFamily="var(--font-mono)" textAnchor="middle">♭</text>
      <line x1={VIEW_W / 2} y1={BASE_Y + 4} x2={VIEW_W / 2} y2={BASE_Y + 9} stroke="#3a4452" strokeWidth="1.4" strokeLinecap="round" />
      <text x={VIEW_W - PAD_X} y={VIEW_H - 6} fill="#4f7196" fontSize="13" fontFamily="var(--font-mono)" textAnchor="middle">♯</text>
    </svg>
  );
};
