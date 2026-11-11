import { useState } from 'react';
import { Button } from '../../../shared/ui/Button';
import { DownloadIcon, PauseIcon, PlayIcon } from '../../../shared/ui/icons';
import { NumberInput } from '../../../shared/ui/NumberInput';
import { RangeSlider } from '../../../shared/ui/RangeSlider';
import { SegmentedControl } from '../../../shared/ui/SegmentedControl';
import { Select } from '../../../shared/ui/Select';
import { TransportButton } from '../../../shared/ui/TransportButton';
import {
  BPM_MAX,
  BPM_MIN,
  KIT_LABELS,
  KITS,
  METERS,
  SWING_MAX,
  type DrumKit,
  type DrumsState,
  type Meter,
} from '../lib/model';
import { GENRES, genreOf } from '../lib/presets';

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

/** Two rows: groove (play · genre · variation · export) on top, feel
 *  (tempo · meter · length · swing) below — one row overflowed 920px and
 *  squeezed the BPM field until its digits were clipped. */
export const TransportBar = ({ state, isPlaying, onToggle, onPreset, onPatch, onTap, onExport }: Props) => {
  // The genre picker remembers the last genre even after a hand edit turns
  // the pattern "Custom", so the variation list stays meaningful.
  const [genreId, setGenreId] = useState(() => genreOf(state.preset_id)?.id ?? GENRES[0].id);
  const presetGenre = genreOf(state.preset_id)?.id;
  if (presetGenre && presetGenre !== genreId) setGenreId(presetGenre);
  const genre = GENRES.find((g) => g.id === genreId) ?? GENRES[0];
  const inGenre = genre.variants.some((v) => v.id === state.preset_id);

  const variationOptions = [
    ...(inGenre ? [] : [{ value: CUSTOM, label: 'Custom' }]),
    ...genre.variants.map((v) => ({ value: v.id, label: v.name })),
  ];

  const nudgeBpm = (d: number) => onPatch({ bpm: state.bpm + d });

  return (
    <div className="flex shrink-0 flex-col gap-2.5">
      <div className="flex items-center gap-3">
        <TransportButton
          title={isPlaying ? 'Stop (Space)' : 'Play (Space)'}
          active={isPlaying}
          onClick={onToggle}
          size="lg"
        >
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </TransportButton>

        <div>
          <Select<string>
            size="sm"
            value={genre.id}
            onChange={(id) => {
              setGenreId(id);
              const g = GENRES.find((x) => x.id === id);
              if (g) onPreset(g.variants[0].id);
            }}
            options={GENRES.map((g) => ({ value: g.id, label: g.name }))}
            label="Genre"
          />
        </div>
        <div>
          <Select<string>
            size="sm"
            value={inGenre && state.preset_id ? state.preset_id : CUSTOM}
            onChange={(id) => id !== CUSTOM && onPreset(id)}
            options={variationOptions}
            label="Variation"
          />
        </div>

        <SegmentedControl<DrumKit>
          size="sm"
          value={state.kit}
          onChange={(kit) => onPatch({ kit })}
          options={KITS.map((k) => ({
            value: k,
            label: KIT_LABELS[k],
            title:
              k === 'acoustic'
                ? 'Recorded studio kit (Virtuosity Drums)'
                : k === 'rock'
                  ? 'Big recorded rock kit (Big Rusty Drums)'
                  : 'Synthesized analog drum machine',
          }))}
          ariaLabel="Drum kit"
        />

        <div className="ml-auto">
          <Button size="sm" variant="soft" tone="accent" leadingIcon={<DownloadIcon />} onClick={onExport}>
            Export
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-1" role="group" aria-label="Tempo">
          <span className="t-secondary text-meta mr-1">BPM</span>
          <Button size="sm" variant="soft" shape="square" onClick={() => nudgeBpm(-1)} title="Slower (−1 BPM)">
            −
          </Button>
          <div className="w-14">
            <NumberInput
              size="sm"
              value={state.bpm}
              onChange={(v) => v !== null && onPatch({ bpm: v })}
              min={BPM_MIN}
              max={BPM_MAX}
              hideStepper
              ariaLabel="Tempo (BPM)"
              className="text-center tabular-nums"
            />
          </div>
          <Button size="sm" variant="soft" shape="square" onClick={() => nudgeBpm(1)} title="Faster (+1 BPM)">
            +
          </Button>
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

        <div
          className={`flex items-center gap-2 ${state.meter === '12/8' ? 'opacity-40' : ''}`}
          title={state.meter === '12/8' ? 'Triplet grid — the swing is in the pattern' : 'Delay every off-16th'}
        >
          <span className="t-secondary text-meta">Swing</span>
          {/* Fixed-width wrapper: `.stash-range` is width:100% and wins over
              a width utility on the input itself. */}
          <div className="w-24">
            <RangeSlider
              value={Math.round(state.swing * 100)}
              onChange={(v) => onPatch({ swing: v / 100 })}
              max={SWING_MAX * 100}
              label="Swing amount"
              disabled={state.meter === '12/8'}
            />
          </div>
          <span className="t-secondary text-meta w-8 tabular-nums">{Math.round(state.swing * 100)}%</span>
        </div>
      </div>
    </div>
  );
};
