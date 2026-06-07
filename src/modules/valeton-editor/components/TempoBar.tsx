import { useId, useState } from 'react';
import { setBpm, setDivision, tapTempo, toggleGlobalBPM } from '../lib/actions';
import { useStore } from '../store/store';
import type { TapDivision } from '../store/types';
import { Fader } from './ui/Fader';
import { ToggleSwitch } from './ui/ToggleSwitch';

const DIVISIONS: { value: TapDivision; title: string }[] = [
  { value: 'quarter', title: 'Quarter note' },
  { value: 'eighth', title: 'Eighth note' },
  { value: 'dotted', title: 'Dotted eighth' },
];

/** SVG-гліф ноти: чверть / восьма / чверть з крапкою. */
const NoteGlyph = ({ kind, lit }: { kind: TapDivision; lit: boolean }) => {
  const c = lit ? '#eaf3ff' : '#8b94a3';
  return (
    <svg
      viewBox="0 0 26 26"
      className="h-[18px] w-[18px]"
      aria-hidden="true"
      style={
        lit
          ? { filter: 'drop-shadow(0 0 4px rgba(74,163,255,0.95))' }
          : undefined
      }
    >
      <g fill={c}>
        <ellipse
          cx="8"
          cy="19"
          rx="4.6"
          ry="3.3"
          transform="rotate(-24 8 19)"
        />
        <rect x="11.6" y="5.4" width="1.9" height="13.9" rx="0.9" />
        {kind === 'eighth' && (
          <path d="M13.5 5.5 C 19 6.5 20.6 10.8 17.9 14.4 C 19.9 11 18.7 8.3 13.5 8.9 Z" />
        )}
        {kind === 'dotted' && <circle cx="17" cy="18.4" r="1.8" />}
      </g>
    </svg>
  );
};

/** Кругла металева клавіша кроку BPM (±1). */
const StepKey = ({
  sign,
  disabled,
  onClick,
  dataId,
  title,
}: {
  sign: 'plus' | 'minus';
  disabled: boolean;
  onClick: () => void;
  dataId: string;
  title: string;
}) => {
  const uid = useId();
  const body = `${uid}-body`;
  return (
    <button
      type="button"
      data-id={dataId}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="h-6 w-6 rounded-full outline-none transition hover:brightness-125 focus-visible:ring-2 focus-visible:ring-ve-accent active:translate-y-px disabled:opacity-40 disabled:hover:brightness-100"
    >
      <svg viewBox="0 0 40 40" className="h-full w-full" aria-hidden="true">
        <defs>
          <radialGradient id={body} cx="50%" cy="32%" r="70%">
            <stop offset="0%" stopColor="#363d48" />
            <stop offset="55%" stopColor="#1b2027" />
            <stop offset="100%" stopColor="#0b0d11" />
          </radialGradient>
        </defs>
        <circle cx="20" cy="20" r="17.5" fill="#05070a" />
        <circle
          cx="20"
          cy="20"
          r="16.5"
          fill={`url(#${body})`}
          stroke="#ffffff1c"
        />
        <ellipse cx="20" cy="13" rx="10" ry="5" fill="#ffffff10" />
        {/* гліф */}
        <rect x="11" y="18.6" width="18" height="2.8" rx="1.4" fill="#cfe0f2" />
        {sign === 'plus' && (
          <rect
            x="18.6"
            y="11"
            width="2.8"
            height="18"
            rx="1.4"
            fill="#cfe0f2"
          />
        )}
      </svg>
    </button>
  );
};

/** SVG-площадка TAP: LED спалахує лише в момент натискання. */
const TapPad = ({
  disabled,
  onTap,
}: {
  disabled: boolean;
  onTap: () => void;
}) => {
  const uid = useId();
  const plate = `${uid}-plate`;
  const [flash, setFlash] = useState(0);
  return (
    <button
      type="button"
      data-id="btn_tap"
      disabled={disabled}
      onClick={() => {
        onTap();
        setFlash((n) => n + 1);
      }}
      className="h-7 w-[58px] rounded-lg outline-none transition hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ve-accent active:translate-y-px disabled:opacity-40"
    >
      <svg viewBox="0 0 80 32" className="h-full w-full" aria-hidden="true">
        <defs>
          <linearGradient id={plate} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2b323c" />
            <stop offset="52%" stopColor="#1a1f26" />
            <stop offset="100%" stopColor="#0d1116" />
          </linearGradient>
        </defs>
        <rect
          x="1.5"
          y="1.5"
          width="77"
          height="29"
          rx="8"
          fill={`url(#${plate})`}
          stroke="#05070a"
        />
        <rect
          x="2"
          y="2"
          width="76"
          height="28"
          rx="7.5"
          fill="none"
          stroke="#ffffff16"
        />
        {/* LED-сенсор: світиться лише коротким спалахом на tap */}
        <circle cx="16" cy="16" r="6" fill="#070a0e" stroke="#0008" />
        <circle
          key={flash}
          cx="16"
          cy="16"
          r="3.3"
          fill="#4aa3ff"
          style={{
            transformBox: 'fill-box',
            transformOrigin: 'center',
            opacity: 0.35,
            animation: flash ? 'tap-flash 0.32s ease-out' : undefined,
          }}
        />
        <text
          x="50"
          y="21"
          textAnchor="middle"
          className="fill-ve-text font-semibold"
          style={{ fontSize: 12, letterSpacing: 2 }}
        >
          TAP
        </text>
      </svg>
    </button>
  );
};

/** Темпо-секція delay-блока: метроном-маркер, поділки (тільки іконки нот),
 *  TAP, кроки ±1, фейдер BPM і перемикач Global tempo. Division і BPM напряму
 *  перераховують час затримки (див. `setDivision` / `setBpm` в `actions.ts`),
 *  тож контрол живе саме у картці DLY. */
export const TempoBar = () => {
  const locked = useStore((s) => s.locked);
  const tapDivision = useStore((s) => s.tapDivision);
  const globalBPMOn = useStore((s) => s.globalBPMOn);
  const bpm = useStore((s) => s.bpm);

  return (
    <div className="mt-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-xl border border-ve-stroke bg-ve-bg-1/60 px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        {DIVISIONS.map((d) => {
          const active = tapDivision === d.value;
          return (
            <button
              key={d.value}
              type="button"
              data-id={`tap_${d.value}`}
              disabled={locked}
              title={d.title}
              className="rounded p-0.5 outline-none transition hover:bg-ve-bg-3 focus-visible:ring-2 focus-visible:ring-ve-accent disabled:opacity-40"
              onClick={() => setDivision(d.value)}
            >
              <NoteGlyph kind={d.value} lit={active} />
            </button>
          );
        })}
      </div>

      <TapPad disabled={locked} onTap={() => tapTempo()} />

      <div className="flex items-center gap-1">
        <StepKey
          sign="minus"
          dataId="btn_tap_minus"
          title="BPM -1"
          disabled={locked}
          onClick={() => setBpm(bpm - 1)}
        />
        <StepKey
          sign="plus"
          dataId="btn_tap_plus"
          title="BPM +1"
          disabled={locked}
          onClick={() => setBpm(bpm + 1)}
        />
      </div>

      <Fader
        label="BPM"
        width={56}
        dataId="global_bpm_value"
        disabled={locked}
        min={40}
        max={240}
        step={1}
        value={bpm}
        onChange={(v) => setBpm(v)}
      />

      <span className="h-4 w-px bg-ve-stroke" />

      {/* Toggle + підпис тримаємо в одному нерозривному блоці, щоб GLOBAL
          не «відривався» на власний рядок при переносі */}
      <label className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap">
        <ToggleSwitch
          checked={globalBPMOn}
          disabled={locked}
          dataId="globalbpm_switch"
          label="Global tempo"
          size={24}
          onChange={(on) => toggleGlobalBPM(on)}
        />
        <span className="text-[10px] font-semibold tracking-wide text-ve-text">
          GLOBAL
        </span>
      </label>
    </div>
  );
};
