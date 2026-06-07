import { useId, useRef } from 'react';
import { displayParam } from '../../lib/actions';
import { roundToStep } from '../../lib/utils';

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  dataId?: string;
  size?: number;
  /** Текст у центрі замість числа (для дискретних параметрів-переліків). */
  display?: string;
  onChange: (value: number) => void;
}

const A_MIN = -135;
const A_MAX = 135;
const SWEEP = A_MAX - A_MIN;

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

// точка на колі (0° = вгору, за годинниковою)
const pt = (
  cx: number,
  cy: number,
  r: number,
  deg: number,
): [number, number] => {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
};

const arcPath = (
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
): string => {
  const [x0, y0] = pt(cx, cy, r, a0);
  const [x1, y1] = pt(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
};

/** Поворотна ручка: drag (вертикально), коліщатко та стрілки.
   Shift — точне підлаштування. */
export const Knob = ({
  label,
  value,
  min,
  max,
  step,
  disabled,
  dataId,
  size = 64,
  display,
  onChange,
}: Props) => {
  const drag = useRef<{ y: number; value: number } | null>(null);
  const uid = useId();
  const gArc = `${uid}-arc`;
  const gBody = `${uid}-body`;
  const fGlow = `${uid}-glow`;
  const shown = displayParam(value, step);
  const span = max - min || 1;
  const frac = clamp((shown - min) / span, 0, 1);
  const angle = A_MIN + frac * SWEEP;

  const set = (v: number) => {
    const nv = clamp(roundToStep(v, step), min, max);
    if (nv !== value) onChange(nv);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, value: shown };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const sens = (e.shiftKey ? 800 : 200) / span;
    set(drag.current.value + (drag.current.y - e.clientY) / sens);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      e.preventDefault();
      set(shown + step);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      e.preventDefault();
      set(shown - step);
    }
  };

  return (
    <div className="flex flex-col items-center gap-1 select-none">
      <div
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={shown}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        data-id={dataId}
        style={{ width: size, height: size }}
        className={`touch-none rounded-full outline-none ${disabled ? 'opacity-40' : 'cursor-ns-resize focus-visible:ring-2 focus-visible:ring-ve-accent'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
        onWheel={(e) => !disabled && set(shown + (e.deltaY < 0 ? step : -step))}
      >
        <svg viewBox="0 0 72 72" className="h-full w-full" aria-hidden="true">
          <defs>
            {/* неоновий градієнт дуги */}
            <linearGradient id={gArc} x1="0" y1="1" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--color-ve-accent-700)" />
              <stop offset="100%" stopColor="var(--color-ve-accent)" />
            </linearGradient>
            {/* металевий корпус, підсвічений згори */}
            <radialGradient id={gBody} cx="50%" cy="34%" r="68%">
              <stop offset="0%" stopColor="#363d48" />
              <stop offset="55%" stopColor="#1b2027" />
              <stop offset="100%" stopColor="#0b0d11" />
            </radialGradient>
            {/* м'яке свічення */}
            <filter id={fGlow} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="2.1" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* заглиблена доріжка */}
          <path
            d={arcPath(36, 36, 29, A_MIN, A_MAX)}
            fill="none"
            stroke="#070a0e"
            strokeWidth={6}
            strokeLinecap="round"
          />
          <path
            d={arcPath(36, 36, 29, A_MIN, A_MAX)}
            fill="none"
            stroke="#262c34"
            strokeWidth={3}
            strokeLinecap="round"
          />
          {/* заповнення зі свіченням */}
          {angle > A_MIN + 0.5 && (
            <path
              d={arcPath(36, 36, 29, A_MIN, angle)}
              fill="none"
              stroke={`url(#${gArc})`}
              strokeWidth={4}
              strokeLinecap="round"
              filter={`url(#${fGlow})`}
            />
          )}
          {/* тіло ручки + фаска */}
          <circle
            cx={36}
            cy={36}
            r={21}
            fill={`url(#${gBody})`}
            stroke="#05070a"
            strokeWidth={1}
          />
          <circle
            cx={36}
            cy={36}
            r={20.5}
            fill="none"
            stroke="#ffffff1c"
            strokeWidth={1}
          />
          {/* блик зверху */}
          <ellipse cx={36} cy={27} rx={12} ry={6} fill="#ffffff0d" />
          {/* покажчик */}
          <line
            x1={pt(36, 36, 11, angle)[0]}
            y1={pt(36, 36, 11, angle)[1]}
            x2={pt(36, 36, 19, angle)[0]}
            y2={pt(36, 36, 19, angle)[1]}
            stroke="#d4e8ff"
            strokeWidth={2.5}
            strokeLinecap="round"
            filter={`url(#${fGlow})`}
          />
          {/* числове значення (або текст переліку) */}
          <text
            x={36}
            y={40}
            textAnchor="middle"
            className={`fill-ve-text font-mono font-bold ${
              display && display.length > 4 ? 'text-[11px]' : 'text-[14px]'
            }`}
          >
            {display ?? shown}
          </text>
        </svg>
      </div>
      <span className="field-label text-center leading-tight">{label}</span>
    </div>
  );
};
