import { Button } from '../../../shared/ui/Button';
import { DownloadIcon, PauseIcon, PlayIcon } from '../../../shared/ui/icons';
import { NumberInput } from '../../../shared/ui/NumberInput';
import { RangeSlider } from '../../../shared/ui/RangeSlider';
import { SegmentedControl } from '../../../shared/ui/SegmentedControl';
import { Select } from '../../../shared/ui/Select';
import { TransportButton } from '../../../shared/ui/TransportButton';
import { BPM_MAX, BPM_MIN, METERS, SWING_MAX, type DrumsState, type Meter } from '../lib/model';
import { PRESETS } from '../lib/presets';

const CUSTOM = '__custom';

type Props = {
  state: DrumsState;
  isPlaying: boolean;
  onToggle: () => void;
  onPreset: (id: string) => void;
  onPatch: (patch: Partial<DrumsState>) => void;
  onTap: () => void;
  onExport: () => void;
};

export const TransportBar = ({ state, isPlaying, onToggle, onPreset, onPatch, onTap, onExport }: Props) => {
  const presetOptions = [
    ...(state.preset_id === null ? [{ value: CUSTOM, label: 'Custom' }] : []),
    ...PRESETS.map((p) => ({ value: p.id, label: p.name })),
  ];
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
      <TransportButton
        title={isPlaying ? 'Stop (Space)' : 'Play (Space)'}
        active={isPlaying}
        onClick={onToggle}
        size="lg"
      >
        {isPlaying ? <PauseIcon /> : <PlayIcon />}
      </TransportButton>

      <div className="w-44">
        <Select<string>
          size="sm"
          value={state.preset_id ?? CUSTOM}
          onChange={(v) => v !== CUSTOM && onPreset(v)}
          options={presetOptions}
          label="Groove preset"
        />
      </div>

      <div className="flex items-center gap-1">
        <div className="w-[88px]">
          <NumberInput
            size="sm"
            value={state.bpm}
            onChange={(v) => v !== null && onPatch({ bpm: v })}
            min={BPM_MIN}
            max={BPM_MAX}
            suffix="bpm"
            ariaLabel="Tempo (BPM)"
          />
        </div>
        <Button size="sm" variant="soft" onClick={onTap} title="Tap tempo">
          Tap
        </Button>
      </div>

      <SegmentedControl<Meter>
        size="sm"
        value={state.meter}
        onChange={(meter) => onPatch({ meter })}
        options={METERS.map((m) => ({ value: m, label: m }))}
        ariaLabel="Time signature"
      />

      <SegmentedControl<'1' | '2'>
        size="sm"
        value={state.bars === 2 ? '2' : '1'}
        onChange={(b) => onPatch({ bars: b === '2' ? 2 : 1 })}
        options={[
          { value: '1', label: '1 bar' },
          { value: '2', label: '2 bars', title: 'Two-bar pattern — room for a fill' },
        ]}
        ariaLabel="Pattern length"
      />

      <label
        className={`flex items-center gap-1.5 text-meta t-secondary ${state.meter === '12/8' ? 'opacity-40' : ''}`}
        title={state.meter === '12/8' ? 'Triplet grid — the swing is in the pattern' : 'Delay every off-16th'}
      >
        Swing
        <RangeSlider
          value={Math.round(state.swing * 100)}
          onChange={(v) => onPatch({ swing: v / 100 })}
          max={SWING_MAX * 100}
          label="Swing amount"
          disabled={state.meter === '12/8'}
          className="w-20"
        />
        <span className="w-8 tabular-nums">{Math.round(state.swing * 100)}%</span>
      </label>

      <div className="ml-auto">
        <Button size="sm" variant="soft" tone="accent" leadingIcon={<DownloadIcon />} onClick={onExport}>
          Export
        </Button>
      </div>
    </div>
  );
};
