import { SegmentedControl, type SegmentOption } from '../../../shared/ui/SegmentedControl';
import {
  DENOMINATORS,
  NUMERATOR_MAX,
  NUMERATOR_MIN,
  SOUND_PRESETS,
  SUBDIVISIONS,
  type MetronomeState,
  type SoundId,
} from '../metronome.constants';
import { NoteGlyph, type NoteKind } from './NoteGlyph';
import { SetupRow } from './SetupRow';
import { Stepper } from './Stepper';

interface ControlsProps {
  state: MetronomeState;
  onPatch: (patch: Partial<MetronomeState>) => void;
}

const SUB_KIND: Record<number, NoteKind> = {
  1: 'quarter',
  2: 'eighth',
  3: 'triplet',
  4: 'sixteenth',
};

const denominatorOptions: SegmentOption[] = DENOMINATORS.map((d) => ({
  value: String(d),
  label: String(d),
  title: String(d),
}));

const subdivisionOptions: SegmentOption[] = SUBDIVISIONS.map((s) => ({
  value: String(s.value),
  label: <NoteGlyph kind={SUB_KIND[s.value]} size={18} />,
  title: s.title,
}));

const soundOptions: SegmentOption[] = SOUND_PRESETS.map((p) => ({
  value: p.id,
  label: p.label,
  title: p.label,
}));

/** Signature · Division · Sound — the core sound shape of the metronome,
 *  rendered as three hair-lined rows in the setup sheet. Returns a fragment so
 *  the rows are direct siblings of the Levels / Trainer / Presets rows and the
 *  dividers line up across components. */
export const Controls = ({ state, onPatch }: ControlsProps) => (
  <>
    <SetupRow label="Signature">
      <Stepper
        value={state.numerator}
        min={NUMERATOR_MIN}
        max={NUMERATOR_MAX}
        onChange={(v) => onPatch({ numerator: v })}
        decLabel="Decrease numerator"
        incLabel="Increase numerator"
        valueWidth={22}
      />
      <span className="metro-sig-slash" aria-hidden="true">
        /
      </span>
      <SegmentedControl
        ariaLabel="Denominator"
        size="sm"
        value={String(state.denominator)}
        onChange={(v) => onPatch({ denominator: Number(v) })}
        options={denominatorOptions}
      />
    </SetupRow>

    <SetupRow label="Division">
      <SegmentedControl
        ariaLabel="Subdivision"
        size="sm"
        value={String(state.subdivision)}
        onChange={(v) => onPatch({ subdivision: Number(v) as 1 | 2 | 3 | 4 })}
        options={subdivisionOptions}
      />
    </SetupRow>

    <SetupRow label="Sound">
      <SegmentedControl
        ariaLabel="Sound"
        size="sm"
        value={state.sound}
        onChange={(v) => onPatch({ sound: v as SoundId })}
        options={soundOptions}
      />
    </SetupRow>
  </>
);
