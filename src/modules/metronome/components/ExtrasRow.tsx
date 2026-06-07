import { Button } from '../../../shared/ui/Button';
import { IconButton } from '../../../shared/ui/IconButton';
import { Toggle } from '../../../shared/ui/Toggle';
import { SetupRow } from './SetupRow';
import { Stepper } from './Stepper';
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

const newPresetId = () => `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

const defaultPresetName = (s: MetronomeState): string => {
  const sub = ['', '♩', '♪', '♪♪♪', '♬'][s.subdivision] ?? '';
  return `${s.bpm} · ${s.numerator}/${s.denominator}${sub ? ` ${sub}` : ''}`;
};

/** A trainer field: a labelled stepper stacked over its caption. */
const TrainerField = ({
  caption,
  ...stepper
}: {
  caption: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  decLabel: string;
  incLabel: string;
  suffix?: string;
  testId: string;
}) => (
  <div className="metro-trainer-field">
    <Stepper {...stepper} />
    <span className="metro-field-cap">{caption}</span>
  </div>
);

/** Trainer + Presets rows of the setup sheet. Returned as a fragment so the
 *  rows sit beside the Signature / Division / Sound / Levels rows under one
 *  parent and share the same hairline dividers. */
export const ExtrasRow = ({ state, onPatch }: Props) => {
  const { trainer, presets } = state;

  const patchTrainer = (p: Partial<TrainerConfig>) => onPatch({ trainer: { ...trainer, ...p } });

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
    <>
      <SetupRow label="Trainer" align="start">
        <div className="metro-trainer-body" data-testid="trainer-row">
          <div className="metro-trainer-head">
            <Toggle checked={trainer.enabled} onChange={(v) => patchTrainer({ enabled: v })} label="Trainer mode" />
            <span className="metro-trainer-hint">
              {trainer.enabled ? 'Ramping BPM as you play' : 'Build speed over time'}
            </span>
          </div>

          {/* Steppers reveal below (grid-rows 0fr → 1fr) instead of shoving the
              layout, and drop from tab + a11y order while collapsed. */}
          <div className="metro-trainer-bay" data-open={trainer.enabled || undefined}>
            <div className="metro-trainer-bay-inner">
              <div className="metro-trainer-fields" inert={!trainer.enabled}>
                <TrainerField
                  caption="Step"
                  value={trainer.step_bpm}
                  min={TRAINER_STEP_MIN}
                  max={TRAINER_STEP_MAX}
                  onChange={(v) => patchTrainer({ step_bpm: v })}
                  decLabel="Decrease Step"
                  incLabel="Increase Step"
                  suffix="bpm"
                  testId="trainer-step"
                />
                <TrainerField
                  caption="Every"
                  value={trainer.every_bars}
                  min={TRAINER_BARS_MIN}
                  max={TRAINER_BARS_MAX}
                  onChange={(v) => patchTrainer({ every_bars: v })}
                  decLabel="Decrease Every"
                  incLabel="Increase Every"
                  suffix={trainer.every_bars === 1 ? 'bar' : 'bars'}
                  testId="trainer-bars"
                />
                <TrainerField
                  caption="Target"
                  value={trainer.target_bpm}
                  min={BPM_MIN}
                  max={BPM_MAX}
                  onChange={(v) => patchTrainer({ target_bpm: v })}
                  decLabel="Decrease Target"
                  incLabel="Increase Target"
                  suffix="bpm"
                  testId="trainer-target"
                />
              </div>
            </div>
          </div>
        </div>
      </SetupRow>

      <SetupRow label="Presets">
        <div className="metro-presets" data-testid="presets-row">
          <Button variant="soft" tone="accent" size="sm" onClick={saveCurrent} data-testid="preset-save">
            + Save current
          </Button>
          <div className="metro-preset-list scroll-area" data-testid="preset-chips">
            {presets.map((p) => (
              <div key={p.id} className="metro-preset-chip group">
                <button
                  type="button"
                  className="metro-chip-apply"
                  onClick={() => applyPreset(p)}
                  data-testid={`preset-chip-${p.id}`}
                >
                  {p.name}
                </button>
                <IconButton
                  onClick={() => deletePreset(p.id)}
                  title={`Delete preset ${p.name}`}
                  tone="danger"
                  tooltipSide="top"
                  data-testid={`preset-delete-${p.id}`}
                >
                  ×
                </IconButton>
              </div>
            ))}
            {!presets.length && <span className="metro-presets-empty">No presets yet</span>}
          </div>
        </div>
      </SetupRow>
    </>
  );
};
