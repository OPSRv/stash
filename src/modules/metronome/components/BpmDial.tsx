import { useCallback, useEffect, useRef, useState } from 'react';
import { accent } from '../../../shared/theme/accent';
import { BPM_MAX, BPM_MIN, tempoName } from '../metronome.constants';

type Props = {
  bpm: number;
  onChange: (bpm: number) => void;
  /** Pulse trigger — increment from parent on every beat. */
  pulseSeq: number;
  pulseAccent: boolean;
  isPlaying: boolean;
};

const SIZE = 288;
const STROKE = 5;
const RADIUS = SIZE / 2 - 24;
const TICK_RADIUS = RADIUS + 10;
/** Sweep angle of the BPM arc. 260° lишає місце зверху для хедера-темпу. */
const SWEEP = 260;
/** Start at ~7:30, sweep clockwise through ~4:30. */
const START_DEG = 140;

const TICK_COUNT = 60;

const clamp = (v: number) => Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(v)));

const polar = (cx: number, cy: number, r: number, deg: number) => {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
};

const arcPath = (cx: number, cy: number, r: number, startDeg: number, endDeg: number): string => {
  const start = polar(cx, cy, r, startDeg);
  const end = polar(cx, cy, r, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${large} 1 ${end.x} ${end.y}`;
};

export const BpmDial = ({ bpm, onChange, pulseSeq, pulseAccent, isPlaying }: Props) => {
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const fraction = (bpm - BPM_MIN) / (BPM_MAX - BPM_MIN);
  const endDeg = START_DEG + fraction * SWEEP;
  const trackPath = arcPath(cx, cy, RADIUS, START_DEG, START_DEG + SWEEP);
  const fillPath = arcPath(cx, cy, RADIUS, START_DEG, endDeg);

  // Позиція «бульбашки»-хедлайна на кінці заповненої дуги.
  const head = polar(cx, cy, RADIUS, endDeg);

  const [pulseKey, setPulseKey] = useState(0);
  useEffect(() => {
    if (pulseSeq === 0) return;
    setPulseKey((k) => k + 1);
  }, [pulseSeq]);

  const draggingRef = useRef(false);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const bpmFromPoint = useCallback((clientX: number, clientY: number): number | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const x = clientX - rect.left - cx;
    const y = clientY - rect.top - cy;
    const angle = (Math.atan2(y, x) * 180) / Math.PI + 90;
    let rel = angle - START_DEG;
    if (rel < 0) rel += 360;
    if (rel > SWEEP) {
      rel = rel - SWEEP < 360 - rel ? SWEEP : 0;
    }
    return clamp(BPM_MIN + (rel / SWEEP) * (BPM_MAX - BPM_MIN));
  }, [cx, cy]);

  const onPointerDown = (e: React.PointerEvent) => {
    draggingRef.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const next = bpmFromPoint(e.clientX, e.clientY);
    if (next !== null) onChange(next);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const next = bpmFromPoint(e.clientX, e.clientY);
    if (next !== null) onChange(next);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    draggingRef.current = false;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const step = e.shiftKey ? 5 : 1;
    onChange(clamp(bpm + (e.deltaY < 0 ? step : -step)));
  };

  const gradId = 'metro-arc-grad';
  const filterId = 'metro-arc-glow';

  return (
    <div
      className="metro-dial-wrap relative select-none"
      style={{ width: SIZE, height: SIZE }}
      data-playing={isPlaying}
      data-testid="bpm-dial"
    >
      <div className="metro-dial-glow" aria-hidden />
      <svg
        ref={svgRef}
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        className="cursor-grab active:cursor-grabbing relative"
        style={{ touchAction: 'none', zIndex: 1 }}
      >
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={accent(0.55)} />
            <stop offset="55%" stopColor={accent(1)} />
            <stop offset="100%" stopColor={accent(0.85)} />
          </linearGradient>
          <filter id={filterId} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Обертальне кільце тіків — «годинникова» космічна деталь. */}
        <g
          className={`metro-ticks ${isPlaying ? '' : 'metro-ticks-paused'}`}
          style={{ transformOrigin: `${cx}px ${cy}px` }}
        >
          {Array.from({ length: TICK_COUNT }, (_, i) => {
            const deg = (i / TICK_COUNT) * 360;
            const p1 = polar(cx, cy, TICK_RADIUS, deg);
            const p2 = polar(cx, cy, TICK_RADIUS + (i % 5 === 0 ? 5 : 2.5), deg);
            return (
              <line
                key={i}
                x1={p1.x}
                y1={p1.y}
                x2={p2.x}
                y2={p2.y}
                stroke={i % 5 === 0 ? accent(0.5) : 'rgba(255,255,255,0.12)'}
                strokeWidth={i % 5 === 0 ? 1.2 : 0.6}
                strokeLinecap="round"
              />
            );
          })}
        </g>

        {/* Базовий трек дуги */}
        <path
          d={trackPath}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth={STROKE}
          strokeLinecap="round"
        />
        {/* Заповнена дуга з градієнтом */}
        <path
          d={fillPath}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth={STROKE}
          strokeLinecap="round"
          filter={isPlaying ? `url(#${filterId})` : undefined}
          style={{ transition: 'd 200ms cubic-bezier(0.2,0,0,1)' }}
        />
        {/* «Бульбашка» на кінці дуги — hint, що можна тягнути. */}
        <circle
          cx={head.x}
          cy={head.y}
          r={6}
          fill="#fff"
          style={{ filter: `drop-shadow(0 0 6px ${accent(0.9)})` }}
        />
        <circle
          cx={head.x}
          cy={head.y}
          r={3}
          fill={accent(1)}
        />

        {/* Пульс-кільце на кожен beat */}
        {pulseKey > 0 && (
          <circle
            key={pulseKey}
            cx={cx}
            cy={cy}
            r={RADIUS - 8}
            fill="none"
            stroke={accent(pulseAccent ? 0.95 : 0.6)}
            strokeWidth={pulseAccent ? 2.5 : 1.5}
            style={{
              transformOrigin: '50% 50%',
              animation: `metronome-pulse ${pulseAccent ? 260 : 200}ms ease-out forwards`,
            }}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <div
          className="metro-bpm-num"
          style={{
            fontSize: 108,
            lineHeight: 0.95,
            fontWeight: 200,
          }}
        >
          {bpm}
        </div>
        <div className="metro-tempo-label mt-1">{tempoName(bpm)}</div>
        <div
          className="t-tertiary"
          style={{ fontSize: 9, letterSpacing: '0.22em', textTransform: 'uppercase', marginTop: 4 }}
        >
          BPM
        </div>
      </div>
    </div>
  );
};

export const __test = { arcPath, polar, clamp };
