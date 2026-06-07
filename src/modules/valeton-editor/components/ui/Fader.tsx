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
  /** Ширина фейдера в px. */
  width?: number;
  /** Інлайн-розкладка: підпис · доріжка · значення в один рядок (нижча по
   *  висоті, доріжка тягнеться на всю ширину). За замовч. — вертикальний стек. */
  inline?: boolean;
  onChange: (value: number) => void;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

// геометрія доріжки в координатах viewBox (0..100)
const TRACK_X = 5;
const TRACK_W = 90;

/** Горизонтальний фейдер-прогрес: неонове заповнення + металева ручка.
   Керування: перетягування, коліщатко, стрілки (Shift — точніше). */
export const Fader = ({
  label,
  value,
  min,
  max,
  step,
  disabled,
  dataId,
  width = 88,
  inline = false,
  onChange,
}: Props) => {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const uid = useId();
  const gFill = `${uid}-fill`;
  const gCap = `${uid}-cap`;
  const fGlow = `${uid}-glow`;

  const shown = displayParam(value, step);
  const span = max - min || 1;
  const frac = clamp((shown - min) / span, 0, 1);
  const cx = TRACK_X + TRACK_W * frac;

  const set = (v: number) => {
    const nv = clamp(roundToStep(v, step), min, max);
    if (nv !== value) onChange(nv);
  };

  const setFromClientX = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // межі доріжки в пікселях (5%..95% ширини)
    const x0 = r.left + r.width * (TRACK_X / 100);
    const f = clamp((clientX - x0) / (r.width * (TRACK_W / 100)), 0, 1);
    set(min + f * span);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = true;
    setFromClientX(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (drag.current) setFromClientX(e.clientX);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      set(shown + step);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      set(shown - step);
    }
  };

  const track = (
    <div
      ref={ref}
      role="slider"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={shown}
      aria-disabled={disabled}
      aria-orientation="horizontal"
      tabIndex={disabled ? -1 : 0}
      data-id={dataId}
      className={`w-full touch-none rounded outline-none ${
        disabled
          ? 'opacity-40'
          : 'cursor-ew-resize focus-visible:ring-2 focus-visible:ring-ve-accent'
      }`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
      onWheel={(e) => !disabled && set(shown + (e.deltaY < 0 ? step : -step))}
    >
      <svg
        viewBox="0 0 100 18"
        className="h-[14px] w-full"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
          <defs>
            <linearGradient id={gFill} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--color-ve-accent-700)" />
              <stop offset="100%" stopColor="var(--color-ve-accent)" />
            </linearGradient>
            <linearGradient id={gCap} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#fafcff" />
              <stop offset="45%" stopColor="#cdd8e6" />
              <stop offset="100%" stopColor="#828e9f" />
            </linearGradient>
            <filter id={fGlow} x="-40%" y="-60%" width="180%" height="220%">
              <feGaussianBlur stdDeviation="1.4" />
            </filter>
          </defs>

          {/* заглиблена доріжка */}
          <rect
            x={TRACK_X}
            y="6.5"
            width={TRACK_W}
            height="5"
            rx="2.5"
            fill="#070a0e"
            stroke="#0008"
            strokeWidth="0.6"
          />
          {/* неонове заповнення */}
          {frac > 0.001 && (
            <rect
              x={TRACK_X}
              y="6.5"
              width={TRACK_W * frac}
              height="5"
              rx="2.5"
              fill={`url(#${gFill})`}
              filter={`url(#${fGlow})`}
            />
          )}
          {/* ручка-повзунок (металева) */}
          <g>
            <rect
              x={cx - 3}
              y="2"
              width="6"
              height="14"
              rx="2"
              fill={`url(#${gCap})`}
              stroke="#05070a"
              strokeWidth="0.6"
            />
            <rect
              x={cx - 0.5}
              y="4"
              width="1"
              height="10"
              rx="0.5"
              fill="#5b6470"
            />
          </g>
        </svg>
      </div>
  );

  const valueText = (
    <span className="font-mono text-[11px] font-bold text-ve-text tabular-nums leading-none">
      {shown}
    </span>
  );
  const labelText = <span className="field-label leading-none">{label}</span>;

  if (inline) {
    // Один рядок: підпис · доріжка (тягнеться) · значення — нижчий за стек.
    return (
      <div
        className="flex select-none items-center gap-2"
        style={{ width }}
      >
        {labelText}
        <div className="min-w-0 flex-1">{track}</div>
        {valueText}
      </div>
    );
  }

  return (
    <div
      className="flex select-none flex-col items-center gap-0.5"
      style={{ width }}
    >
      {valueText}
      {track}
      {labelText}
    </div>
  );
};
