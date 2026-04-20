import { SegmentedControl } from '../../../shared/ui/SegmentedControl';
import {
  DENOMINATORS,
  NUMERATOR_MAX,
  NUMERATOR_MIN,
  SOUND_PRESETS,
  SUBDIVISIONS,
  type MetronomeState,
  type SoundId,
} from '../metronome.constants';
import { VolumeSlider } from './VolumeSlider';

interface ControlsProps {
  state: MetronomeState;
  onPatch: (patch: Partial<MetronomeState>) => void;
}

const clampNum = (v: number) => Math.max(NUMERATOR_MIN, Math.min(NUMERATOR_MAX, Math.round(v)));

export const Controls = ({ state, onPatch }: ControlsProps) => {
  const setNumerator = (v: number) => onPatch({ numerator: clampNum(v) });

  return (
    <div className="flex items-center gap-4 px-4 py-2 border-t hair">
      <div className="flex items-center gap-1" aria-label="Time signature">
        <button
          type="button"
          onClick={() => setNumerator(state.numerator - 1)}
          disabled={state.numerator <= NUMERATOR_MIN}
          aria-label="Decrease numerator"
          className="h-7 w-6 rounded-md t-secondary hover:t-primary hover:bg-white/[0.04] disabled:opacity-30"
        >
          −
        </button>
        <div
          className="t-primary font-medium text-body tabular-nums text-center"
          style={{ minWidth: 44 }}
          aria-live="polite"
          data-testid="time-signature-label"
        >
          {state.numerator}/{state.denominator}
        </div>
        <button
          type="button"
          onClick={() => setNumerator(state.numerator + 1)}
          disabled={state.numerator >= NUMERATOR_MAX}
          aria-label="Increase numerator"
          className="h-7 w-6 rounded-md t-secondary hover:t-primary hover:bg-white/[0.04] disabled:opacity-30"
        >
          +
        </button>
        <div className="ml-2">
          <SegmentedControl<string>
            ariaLabel="Denominator"
            size="sm"
            value={String(state.denominator)}
            onChange={(v) => onPatch({ denominator: Number(v) })}
            options={DENOMINATORS.map((d) => ({ value: String(d), label: String(d) }))}
          />
        </div>
      </div>
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
      <SegmentedControl<SoundId>
        ariaLabel="Sound"
        size="sm"
        value={state.sound}
        onChange={(v) => onPatch({ sound: v })}
        options={SOUND_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
      />
      <div className="hair w-px h-6" />
      <VolumeSlider
        value={state.click_volume}
        onChange={(v) => onPatch({ click_volume: v })}
        label="Click"
        testId="vol-click"
      />
      <VolumeSlider
        value={state.accent_volume}
        onChange={(v) => onPatch({ accent_volume: v })}
        label="Accent"
        testId="vol-accent"
      />
    </div>
  );
};
