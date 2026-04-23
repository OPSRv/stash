import { Toggle } from '../../../shared/ui/Toggle';
import {
  BPM_MAX,
  BPM_MIN,
  type MetronomeState,
  type Preset,
  TRAINER_BARS_MAX,
  TRAINER_BARS_MIN,
  TRAINER_STEP_MAX,
  TRAINER_STEP_MIN,
  type TrainerConfig,
} from '../metronome.constants';

type Props = {
  state: MetronomeState;
  onPatch: (patch: Partial<MetronomeState>) => void;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

type StepperCellProps = {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  label: string;
  unit?: string;
  testId: string;
  width?: number;
  step?: number;
};

/** A compact value-with-label tile with −/+ buttons and wheel support. Keeps
 *  trainer knobs readable at a glance instead of shoving raw spinners inline. */
const StepperCell = ({
  value,
  min,
  max,
  onChange,
  label,
  unit,
  testId,
  width = 72,
  step = 1,
}: StepperCellProps) => {
  const bump = (dir: 1 | -1) => onChange(clamp(value + dir * step, min, max));
  return (
    <div
      className="metro-step-cell flex flex-col items-stretch rounded-lg px-1.5 py-1"
      style={{ minWidth: width }}
      data-testid={testId}
      onWheel={(e) => {
        e.preventDefault();
        bump(e.deltaY < 0 ? 1 : -1);
      }}
    >
      <div className="flex items-center justify-between gap-1">
        <button
          type="button"
          aria-label={`Decrease ${label}`}
          onClick={() => bump(-1)}
          disabled={value <= min}
          className="w-5 h-5 flex items-center justify-center rounded t-tertiary hover:t-primary hover:bg-white/[0.08] disabled:opacity-30"
        >
          −
        </button>
        <span className="t-primary text-body font-medium tabular-nums">
          {value}
          {unit ? <span className="t-tertiary text-meta ml-0.5">{unit}</span> : null}
        </span>
        <button
          type="button"
          aria-label={`Increase ${label}`}
          onClick={() => bump(1)}
          disabled={value >= max}
          className="w-5 h-5 flex items-center justify-center rounded t-tertiary hover:t-primary hover:bg-white/[0.08] disabled:opacity-30"
        >
          +
        </button>
      </div>
      <span className="t-tertiary text-meta uppercase tracking-wider text-center mt-0.5">
        {label}
      </span>
    </div>
  );
};

const newPresetId = () => `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

const defaultPresetName = (s: MetronomeState): string => {
  const sub = ['', '♩', '♪', '♪♪♪', '♬'][s.subdivision] ?? '';
  return `${s.bpm} · ${s.numerator}/${s.denominator}${sub ? ` ${sub}` : ''}`;
};

export const ExtrasRow = ({ state, onPatch }: Props) => {
  const { trainer, presets } = state;

  const patchTrainer = (p: Partial<TrainerConfig>) =>
    onPatch({ trainer: { ...trainer, ...p } });

  const applyPreset = (p: Preset) => {
    onPatch({
      bpm: p.bpm,
      numerator: p.numerator,
      denominator: p.denominator,
      subdivision: p.subdivision as 1 | 2 | 3 | 4,
      sound: p.sound,
      beat_accents: [...p.beat_accents],
    });
  };

  const saveCurrent = () => {
    const preset: Preset = {
      id: newPresetId(),
      name: defaultPresetName(state),
      bpm: state.bpm,
      numerator: state.numerator,
      denominator: state.denominator,
      subdivision: state.subdivision,
      sound: state.sound,
      beat_accents: [...state.beat_accents],
    };
    onPatch({ presets: [...presets, preset] });
  };

  const deletePreset = (id: string) => {
    onPatch({ presets: presets.filter((p) => p.id !== id) });
  };

  return (
    <div className="border-t hair">
      {/* Trainer row */}
      <div className="flex items-center gap-3 px-4 py-2" data-testid="trainer-row">
        <Toggle
          checked={trainer.enabled}
          onChange={(v) => patchTrainer({ enabled: v })}
          label="Trainer mode"
        />
        <div className="flex flex-col justify-center">
          <span className="t-primary text-meta font-medium uppercase tracking-wider leading-tight">
            Trainer
          </span>
          <span className="t-tertiary text-meta leading-tight">
            {trainer.enabled
              ? 'Auto-increasing BPM while you play'
              : 'Build speed — ramp BPM over time'}
          </span>
        </div>
        {trainer.enabled && (
          <div className="flex items-center gap-2 ml-auto">
            <StepperCell
              value={trainer.step_bpm}
              min={TRAINER_STEP_MIN}
              max={TRAINER_STEP_MAX}
              onChange={(v) => patchTrainer({ step_bpm: v })}
              label="Step"
              unit="bpm"
              testId="trainer-step"
            />
            <StepperCell
              value={trainer.every_bars}
              min={TRAINER_BARS_MIN}
              max={TRAINER_BARS_MAX}
              onChange={(v) => patchTrainer({ every_bars: v })}
              label="Every"
              unit={trainer.every_bars === 1 ? 'bar' : 'bars'}
              testId="trainer-bars"
              width={80}
            />
            <StepperCell
              value={trainer.target_bpm}
              min={BPM_MIN}
              max={BPM_MAX}
              onChange={(v) => patchTrainer({ target_bpm: v })}
              label="Target"
              unit="bpm"
              testId="trainer-target"
              width={88}
            />
          </div>
        )}
      </div>

      {/* Presets row */}
      <div className="flex items-center gap-3 px-4 py-2 border-t hair" data-testid="presets-row">
        <div className="flex flex-col justify-center shrink-0">
          <span className="t-primary text-meta font-medium uppercase tracking-wider leading-tight">
            Presets
          </span>
          <span className="t-tertiary text-meta leading-tight">
            {presets.length ? 'Click a chip to apply' : 'Save your current settings'}
          </span>
        </div>
        <button
          type="button"
          onClick={saveCurrent}
          data-testid="preset-save"
          className="metro-save-preset shrink-0"
        >
          + Save current
        </button>
        <div
          className="flex items-center gap-1.5 overflow-x-auto nice-scroll flex-1 min-w-0"
          data-testid="preset-chips"
        >
          {presets.map((p) => (
            <div
              key={p.id}
              className="metro-preset-chip group gap-0.5"
            >
              <button
                type="button"
                onClick={() => applyPreset(p)}
                className="pl-2.5 pr-1 py-0.5 text-meta t-primary tabular-nums"
                data-testid={`preset-chip-${p.id}`}
              >
                {p.name}
              </button>
              <button
                type="button"
                onClick={() => deletePreset(p.id)}
                aria-label={`Delete preset ${p.name}`}
                className="w-4 h-4 mr-1 rounded-full t-tertiary hover:t-primary hover:bg-white/[0.12] text-[10px] leading-none flex items-center justify-center"
                data-testid={`preset-delete-${p.id}`}
              >
                ×
              </button>
            </div>
          ))}
          {!presets.length && (
            <span className="t-tertiary text-meta italic">No presets yet</span>
          )}
        </div>
      </div>
    </div>
  );
};
