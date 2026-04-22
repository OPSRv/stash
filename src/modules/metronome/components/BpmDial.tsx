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

const SIZE = 240;
const STROKE = 3;
const RADIUS = SIZE / 2 - 18;
/** Sweep angle of the BPM arc. 270° feels generous and keeps the bottom open
 *  for the beat strip + tap bar. */
const SWEEP = 270;
/** Start at 7 o'clock, sweep clockwise through 5 o'clock. */
const START_DEG = 135;

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
    const angle = (Math.atan2(y, x) * 180) / Math.PI + 90; // 0 = top, increases clockwise
    let rel = angle - START_DEG;
    if (rel < 0) rel += 360;
    if (rel > SWEEP) {
      // Snap to whichever endpoint is closer when the cursor leaves the arc.
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

  return (
    <div
      className="relative select-none"
      style={{ width: SIZE, height: SIZE }}
      data-testid="bpm-dial"
    >
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
        className="cursor-grab active:cursor-grabbing"
        style={{ touchAction: 'none' }}
      >
        <path
          d={trackPath}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth={STROKE}
          strokeLinecap="round"
        />
        <path
          d={fillPath}
          fill="none"
          stroke={accent(isPlaying ? 0.95 : 0.8)}
          strokeWidth={STROKE}
          strokeLinecap="round"
          style={{ transition: 'd 200ms cubic-bezier(0.2,0,0,1)' }}
        />
        {/* Pulse ring */}
        {pulseKey > 0 && (
          <circle
            key={pulseKey}
            cx={cx}
            cy={cy}
            r={RADIUS - 6}
            fill="none"
            stroke={accent(pulseAccent ? 0.9 : 0.55)}
            strokeWidth={pulseAccent ? 2 : 1.5}
            style={{
              transformOrigin: '50% 50%',
              animation: `metronome-pulse ${pulseAccent ? 220 : 180}ms ease-out forwards`,
            }}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <div
          className="t-primary font-light"
          style={{
            fontSize: 80,
            lineHeight: 1,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '-0.04em',
          }}
        >
          {bpm}
        </div>
        <div
          className="t-tertiary mt-2"
          style={{ fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase' }}
        >
          {tempoName(bpm)}
        </div>
      </div>
      <style>{`
        @keyframes metronome-pulse {
          from { opacity: 0.85; transform: scale(1); }
          to { opacity: 0; transform: scale(1.06); }
        }
      `}</style>
    </div>
  );
};

export const __test = { arcPath, polar, clamp };
