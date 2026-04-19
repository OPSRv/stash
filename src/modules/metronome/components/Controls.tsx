import { SegmentedControl } from '../../../shared/ui/SegmentedControl';
import { Select } from '../../../shared/ui/Select';
import {
  SOUND_PRESETS,
  SUBDIVISIONS,
  TIME_SIGNATURES,
  type MetronomeState,
  type SoundId,
} from '../metronome.constants';

type Props = {
  state: MetronomeState;
  onPatch: (patch: Partial<MetronomeState>) => void;
};

const sigKey = (n: number, d: number) => `${n}/${d}`;

const Slider = ({
  value,
  onChange,
  label,
  testId,
}: {
  value: number;
  onChange: (v: number) => void;
  label: string;
  testId?: string;
}) => {
  const pct = Math.round(value * 100);
  return (
    <label className="flex flex-col gap-0.5" style={{ width: 76 }}>
      <span
        className="flex items-baseline justify-between t-tertiary"
        style={{ fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}
      >
        <span>{label}</span>
        <span className="font-mono">{pct}</span>
      </span>
      <input
        type="range"
        min={0}
        max={100}
        value={pct}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        data-testid={testId}
        aria-label={label}
        className="metronome-slider"
        style={{ width: '100%' }}
      />
    </label>
  );
};

export const Controls = ({ state, onPatch }: Props) => {
  return (
    <div className="flex items-center gap-4 px-4 py-2 border-t hair">
      <SegmentedControl
        ariaLabel="Time signature"
        size="sm"
        value={sigKey(state.numerator, state.denominator)}
        options={TIME_SIGNATURES.map((s) => ({
          value: sigKey(s.numerator, s.denominator),
          label: sigKey(s.numerator, s.denominator),
        }))}
        onChange={(v) => {
          const [n, d] = v.split('/').map(Number);
          onPatch({ numerator: n, denominator: d });
        }}
      />
      <div className="hair w-px h-6" />
      <div className="flex items-center gap-1" role="radiogroup" aria-label="Subdivision">
        {SUBDIVISIONS.map((s) => {
          const on = state.subdivision === s.value;
          return (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={s.title}
              title={s.title}
              onClick={() => onPatch({ subdivision: s.value })}
              className={`px-2 h-7 rounded-md text-body transition-colors ${
                on
                  ? 't-primary bg-white/[0.08]'
                  : 't-secondary hover:bg-white/[0.04]'
              }`}
              style={{ minWidth: 28 }}
            >
              {s.label}
            </button>
          );
        })}
      </div>
      <div className="hair w-px h-6" />
      <Select<SoundId>
        value={state.sound}
        onChange={(v) => onPatch({ sound: v })}
        options={SOUND_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
        label="Sound"
      />
      <div className="hair w-px h-6" />
      <Slider
        value={state.click_volume}
        onChange={(v) => onPatch({ click_volume: v })}
        label="Click"
        testId="vol-click"
      />
      <Slider
        value={state.accent_volume}
        onChange={(v) => onPatch({ accent_volume: v })}
        label="Accent"
        testId="vol-accent"
      />
    </div>
  );
};
