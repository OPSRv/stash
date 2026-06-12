/* Key panel: the selected key's identity (name, signature, scale notes),
 * relative/parallel switches, mode + seventh-chord controls, and the seven
 * diatonic chord chips that feed the progression builder.
 *
 * Mode is a *view* setting: the chip grid always shows the selected key's
 * diatonic chords (major or natural minor — matching `diatonicChords`,
 * `romanNumeral` and the preset/transpose helpers, which are all
 * major/minor-based). The mode select only drives the circle's diatonic arc
 * (CircleSvg) and the fretboard scale view. Keeping harmony major/minor-only
 * avoids inventing modal roman-numeral spellings theory.ts doesn't support. */

import { Button } from '../../../shared/ui/Button';
import { Checkbox } from '../../../shared/ui/Checkbox';
import { Select, type SelectOption } from '../../../shared/ui/Select';
import { addChord } from '../lib/actions';
import { pretty } from '../lib/format';
import {
  MODES,
  chordName,
  diatonicChords,
  keySignature,
  parallelOf,
  relativeOf,
  romanNumeral,
  scaleOf,
  slotOfKey,
  spellPitch,
  type Key,
} from '../lib/theory';
import { setState, useStore, type ModeId } from '../store';

/** Full key name: "C major", "F♯ minor". */
const keyLong = (key: Key): string =>
  `${pretty(spellPitch(key.tonic, key))} ${key.minor ? 'minor' : 'major'}`;

/** Switching keys also rotates the wheel, like a sector click would. */
const switchKey = (key: Key): void => setState({ key, rotation: slotOfKey(key) });

const MODE_OPTIONS: SelectOption<ModeId>[] = MODES.map((m) => ({ value: m.id, label: m.label }));

/** One line for the signature: "3♯: F♯ C♯ G♯", "2♭: B♭ E♭", or the C-major
 * empty case spelled out. */
const signatureText = (key: Key): string => {
  const sig = keySignature(key);
  if (sig.sharps > 0) return `${sig.sharps}♯: ${sig.notes.map(pretty).join(' ')}`;
  if (sig.flats > 0) return `${sig.flats}♭: ${sig.notes.map(pretty).join(' ')}`;
  return 'No sharps or flats';
};

export const KeyPanel = () => {
  const key = useStore((s) => s.key);
  const mode = useStore((s) => s.mode);
  const seventh = useStore((s) => s.seventh);

  const chords = diatonicChords(key, seventh);

  return (
    <section className="flex flex-col gap-2 min-w-0" aria-label="Key details">
      <header className="flex items-center gap-1.5 min-w-0">
        <h2 className="text-title font-semibold t-primary flex-1 min-w-0 truncate">
          {keyLong(key)}
        </h2>
        <Button
          size="xs"
          variant="soft"
          title={`Switch to the relative key — ${keyLong(relativeOf(key))}`}
          onClick={() => switchKey(relativeOf(key))}
        >
          Relative
        </Button>
        <Button
          size="xs"
          variant="soft"
          title={`Switch to the parallel key — ${keyLong(parallelOf(key))}`}
          onClick={() => switchKey(parallelOf(key))}
        >
          Parallel
        </Button>
      </header>

      <p className="text-meta t-tertiary">{signatureText(key)}</p>
      <p className="text-body t-secondary tracking-wide">
        {scaleOf(key)
          .map((n) => pretty(n.label))
          .join('  ')}
      </p>

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-meta t-tertiary">Mode</span>
          <Select
            size="sm"
            label="Mode"
            value={mode}
            onChange={(next) => setState({ mode: next })}
            options={MODE_OPTIONS}
          />
        </div>
        <Checkbox
          size="sm"
          checked={seventh}
          onChange={(next) => setState({ seventh: next })}
          label="7th chords"
        />
      </div>

      {/* Seven diatonic chords, 4 + 3. Click appends to the progression (with
          a quiet audition); hover drives the fretboard chord highlight. */}
      <div className="grid grid-cols-4 gap-1" role="group" aria-label="Diatonic chords">
        {chords.map((chord) => (
          <button
            key={chord.root}
            type="button"
            className="circle-chip ring-focus"
            onClick={() => addChord(chord)}
            onMouseEnter={() => setState({ hoveredChord: chord })}
            onMouseLeave={() => setState({ hoveredChord: null })}
            onFocus={() => setState({ hoveredChord: chord })}
            onBlur={() => setState({ hoveredChord: null })}
          >
            <span className="text-meta t-tertiary">{pretty(romanNumeral(chord, key))}</span>
            <span className="text-body t-primary truncate max-w-full">
              {pretty(chordName(chord))}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
};
