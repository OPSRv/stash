import { useCallback, useEffect, useRef, useState } from 'react';
import { BPM_MAX, BPM_MIN, tempoName } from '../metronome.constants';

// Valeton blue accent (matches --color-ve-accent / accent-700) so the dial
// reads as part of the same device as the editor's knobs.
const BLUE = '#4aa3ff';
const BLUE_DEEP = '#2f7fd6';
const BLUE_LITE = '#86c5ff';

type Props = {
  bpm: number;
  onChange: (bpm: number) => void;
  /** Pulse trigger — increment from parent on every beat. */
  pulseSeq: number;
  pulseAccent: boolean;
  isPlaying: boolean;
  /** Outer diameter in px. Defaults to the compact embedded size. */
  size?: number;
};

const STROKE_RATIO = 0.034;
const INSET_RATIO = 0.083;
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

export const BpmDial = ({ bpm, onChange, pulseSeq, pulseAccent, isPlaying, size = 150 }: Props) => {
  const SIZE = size;
  const STROKE = Math.max(3, Math.round(SIZE * STROKE_RATIO));
  const RADIUS = SIZE / 2 - SIZE * INSET_RATIO;
  const TICK_RADIUS = RADIUS + SIZE * 0.035;
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
  const [dragging, setDragging] = useState(false);
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
    setDragging(true);
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
    setDragging(false);
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };

  // Accumulate wheel delta so a trackpad's stream of tiny deltas advances the
  // tempo evenly instead of jumping a full BPM per micro-event; a notch of a
  // mouse wheel still steps cleanly once the threshold is crossed.
  const wheelAccum = useRef(0);
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const THRESHOLD = 28;
    wheelAccum.current += e.deltaY;
    let steps = 0;
    while (wheelAccum.current <= -THRESHOLD) {
      steps += 1;
      wheelAccum.current += THRESHOLD;
    }
    while (wheelAccum.current >= THRESHOLD) {
      steps -= 1;
      wheelAccum.current -= THRESHOLD;
    }
    if (steps !== 0) onChange(clamp(bpm + steps * (e.shiftKey ? 5 : 1)));
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
          <linearGradient id={gradId} x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={BLUE_DEEP} />
            <stop offset="100%" stopColor={BLUE_LITE} />
          </linearGradient>
          <radialGradient id={`${gradId}-hub`} cx="50%" cy="34%" r="70%">
            <stop offset="0%" stopColor="#222936" />
            <stop offset="58%" stopColor="#141a21" />
            <stop offset="100%" stopColor="#0a0d12" />
          </radialGradient>
          <filter id={filterId} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Knurled metal collar — fine static serrations like a real pot, so
            the wheel reads as something you grip and turn. */}
        <g>
          {Array.from({ length: TICK_COUNT }, (_, i) => {
            const deg = (i / TICK_COUNT) * 360;
            const major = i % 5 === 0;
            const p1 = polar(cx, cy, TICK_RADIUS, deg);
            const p2 = polar(cx, cy, TICK_RADIUS + (major ? 5 : 2.5), deg);
            return (
              <line
                key={i}
                x1={p1.x}
                y1={p1.y}
                x2={p2.x}
                y2={p2.y}
                stroke={major ? 'rgba(74,163,255,0.42)' : 'rgba(255,255,255,0.07)'}
                strokeWidth={major ? 1.2 : 0.7}
                strokeLinecap="round"
              />
            );
          })}
        </g>

        {/* Metallic hub — the number is etched on this knob face. A single
            value indicator (the arc + head below) keeps the centre clean; an
            extra inner pointer used to crowd the etched number. */}
        <circle cx={cx} cy={cy} r={RADIUS - STROKE * 1.6} fill={`url(#${gradId}-hub)`} stroke="#05070a" strokeWidth={1} />
        <circle cx={cx} cy={cy} r={RADIUS - STROKE * 1.6} fill="none" stroke="#ffffff14" strokeWidth={1} />
        <ellipse cx={cx} cy={cy - (RADIUS - STROKE * 1.6) * 0.42} rx={(RADIUS - STROKE * 1.6) * 0.62} ry={(RADIUS - STROKE * 1.6) * 0.3} fill="#ffffff0a" />

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
          style={{ transition: dragging ? 'none' : 'd 200ms cubic-bezier(0.2,0,0,1)' }}
        />
        {/* «Бульбашка» на кінці дуги — hint, що можна тягнути. */}
        <circle
          cx={head.x}
          cy={head.y}
          r={6}
          fill="#fff"
          style={{ filter: 'drop-shadow(0 0 6px rgba(74,163,255,0.9))' }}
        />
        <circle cx={head.x} cy={head.y} r={3} fill={BLUE} />

        {/* Пульс-кільце на кожен beat */}
        {pulseKey > 0 && (
          <circle
            key={pulseKey}
            cx={cx}
            cy={cy}
            r={RADIUS - STROKE}
            fill="none"
            stroke={pulseAccent ? 'rgba(74,163,255,0.95)' : 'rgba(74,163,255,0.55)'}
            strokeWidth={pulseAccent ? 2.5 : 1.5}
            style={{
              transformOrigin: '50% 50%',
              animation: `metronome-pulse ${pulseAccent ? 260 : 200}ms ease-out forwards`,
            }}
          />
        )}
      </svg>
      {/* The etched readout must paint ABOVE the SVG hub (which carries its own
          z-index), otherwise the metal face occludes the number. */}
      <div
        className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
        style={{ zIndex: 2 }}
      >
        <div
          className="metro-bpm-num"
          style={{
            fontSize: Math.round(SIZE * 0.34),
            lineHeight: 0.95,
            fontWeight: 400,
          }}
        >
          {bpm}
        </div>
        <div
          className="metro-tempo-label"
          style={{ fontSize: Math.max(9, Math.round(SIZE * 0.058)), marginTop: 2 }}
        >
          {tempoName(bpm)}
        </div>
      </div>
    </div>
  );
};

export const __test = { arcPath, polar, clamp };
