import { useId } from 'react';

interface Props {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  /** Висота тумблера в px (ширина рахується пропорційно). */
  size?: number;
  label?: string;
  dataId?: string;
  /** Колір свічення в стані ON. */
  tone?: 'accent' | 'on';
}

/** Залізний бат-тумблер (як на підсилювачі): металева панель + важіль,
   що перекидається вгору (ON) / вниз (OFF). У стані ON світиться акцентом. */
export const ToggleSwitch = ({
  checked,
  disabled = false,
  onChange,
  size = 56,
  label,
  dataId,
  tone = 'accent',
}: Props) => {
  const uid = useId();
  const gPlate = `${uid}-plate`;
  const gBat = `${uid}-bat`;
  const fGlow = `${uid}-glow`;
  const tint = tone === 'on' ? '#3ddc97' : '#4aa3ff';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-id={dataId}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      style={{ width: Math.round((size * 40) / 60), height: size }}
      className={`touch-none rounded-lg outline-none ${
        disabled
          ? 'opacity-40'
          : 'cursor-pointer focus-visible:ring-2 focus-visible:ring-ve-accent'
      }`}
    >
      <svg viewBox="0 0 40 60" className="h-full w-full" aria-hidden="true">
        <defs>
          {/* металева панель/часис тумблера */}
          <linearGradient id={gPlate} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2c333d" />
            <stop offset="50%" stopColor="#1a1f26" />
            <stop offset="100%" stopColor="#0d1116" />
          </linearGradient>
          {/* хромований важіль */}
          <linearGradient id={gBat} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fafcff" />
            <stop offset="40%" stopColor="#cdd8e6" />
            <stop offset="100%" stopColor="#828e9f" />
          </linearGradient>
          <filter id={fGlow} x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="2.4" />
          </filter>
        </defs>

        {/* панель + фаска */}
        <rect
          x="4"
          y="3"
          width="32"
          height="54"
          rx="9"
          fill={`url(#${gPlate})`}
          stroke="#05070a"
        />
        <rect
          x="4.5"
          y="3.5"
          width="31"
          height="53"
          rx="8.5"
          fill="none"
          stroke="#ffffff14"
        />

        {/* заглиблений слот */}
        <rect x="13" y="9" width="14" height="42" rx="7" fill="#070a0e" />
        <rect
          x="13"
          y="9"
          width="14"
          height="42"
          rx="7"
          fill="none"
          stroke="#0008"
        />

        {/* свічення слота в стані ON */}
        {checked && (
          <circle
            cx="20"
            cy="15"
            r="9"
            fill={tint}
            opacity="0.55"
            filter={`url(#${fGlow})`}
          />
        )}

        {/* важіль: вгору (ON) / вниз (OFF) — поворот на 180° навколо осі (20,31) */}
        <g transform={checked ? undefined : 'rotate(180 20 31)'}>
          <rect x="16.5" y="15" width="7" height="18" rx="3.5" fill="#7c8798" />
          <rect
            x="17.6"
            y="15"
            width="1.7"
            height="18"
            rx="0.8"
            fill="#ffffff55"
          />
          <circle
            cx="20"
            cy="15"
            r="8"
            fill={`url(#${gBat})`}
            stroke="#00000088"
          />
          <ellipse cx="20" cy="12.6" rx="4.4" ry="2.5" fill="#ffffff66" />
          {checked && (
            <circle
              cx="20"
              cy="15"
              r="8"
              fill="none"
              stroke={tint}
              strokeWidth="1.6"
              opacity="0.9"
            />
          )}
        </g>

        {/* нерухомий комір над віссю */}
        <ellipse
          cx="20"
          cy="31"
          rx="11"
          ry="5.5"
          fill="#11151b"
          stroke="#05070a"
        />
        <ellipse cx="20" cy="30" rx="10.5" ry="4.8" fill={`url(#${gPlate})`} />
        <ellipse cx="20" cy="29.3" rx="7.5" ry="2.4" fill="#ffffff14" />
      </svg>
    </button>
  );
};
