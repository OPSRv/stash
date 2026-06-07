/** Flat −/value/+ stepper used by the signature and trainer fields in the
 *  setup panel. Replaces the old engraved metal key (`StepKey`) so the panel
 *  reads as a calm, flat settings sheet rather than a pedal face. Supports
 *  click, wheel (up = +step) and the buttons stay fully labelled for
 *  screen-readers via `incLabel` / `decLabel`. */

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

type NudgeProps = {
  dir: 'inc' | 'dec';
  label: string;
  onClick: () => void;
  disabled?: boolean;
};

const Nudge = ({ dir, label, onClick, disabled }: NudgeProps) => (
  <button type="button" className="metro-nudge" onClick={onClick} disabled={disabled} aria-label={label}>
    <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden="true">
      <line x1="4" y1="8" x2="12" y2="8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      {dir === 'inc' && <line x1="8" y1="4" x2="8" y2="12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
    </svg>
  </button>
);

type StepperProps = {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  /** Accessible name for the − button (e.g. "Decrease numerator"). */
  decLabel: string;
  /** Accessible name for the + button (e.g. "Increase numerator"). */
  incLabel: string;
  /** Small unit rendered after the value (e.g. "bpm", "bars"). */
  suffix?: string;
  testId?: string;
  /** Min width of the value cell so the row never reflows as digits change. */
  valueWidth?: number;
};

export const Stepper = ({
  value,
  min,
  max,
  step = 1,
  onChange,
  decLabel,
  incLabel,
  suffix,
  testId,
  valueWidth = 26,
}: StepperProps) => {
  const bump = (dir: 1 | -1) => onChange(clamp(value + dir * step, min, max));
  return (
    <div
      className="metro-stepper"
      data-testid={testId}
      onWheel={(e) => {
        e.preventDefault();
        bump(e.deltaY < 0 ? 1 : -1);
      }}
    >
      <Nudge dir="dec" label={decLabel} onClick={() => bump(-1)} disabled={value <= min} />
      <span className="metro-stepper-val tabular-nums" style={{ minWidth: valueWidth }}>
        {value}
        {suffix ? <span className="metro-stepper-unit">{suffix}</span> : null}
      </span>
      <Nudge dir="inc" label={incLabel} onClick={() => bump(1)} disabled={value >= max} />
    </div>
  );
};
