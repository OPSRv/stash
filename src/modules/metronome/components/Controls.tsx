import { SegmentedControl } from '../../../shared/ui/SegmentedControl';
import { Select } from '../../../shared/ui/Select';
import {
  SOUND_PRESETS,
  SUBDIVISIONS,
  TIME_SIGNATURES,
  type MetronomeState,
  type SoundId,
} from '../metronome.constants';
import { VolumeSlider } from './VolumeSlider';

interface ControlsProps {
  state: MetronomeState;
  onPatch: (patch: Partial<MetronomeState>) => void;
}

const sigKey = (n: number, d: number): string => `${n}/${d}`;

export const Controls = ({ state, onPatch }: ControlsProps) => {
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
