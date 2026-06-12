/* Fretboard hint — a compact 12-fret neck that lights up where the current
 * scale (or chord) lives in the selected tuning.
 *
 * Visual conventions follow the tuner's Fretboard (top string = highest, open
 * notes in the nut gutter, inlay dots at 3/5/7/9/12, fret-number strip) but
 * nothing is imported from that module — only the shared tunings data is
 * common, per the module isolation rules.
 *
 * Decisions, documented once here:
 * - Scale view shows the MODE scale on the selected tonic —
 *   `modeScale(key.tonic, mode)` — exactly the set CircleSvg derives its
 *   diatonic arc from, so the wheel and the neck always agree. `key.minor`
 *   doesn't enter the scale view; pick Aeolian to see the natural minor.
 * - Pentatonic *filters* that scale: degrees 1-2-3-5-6 ({0,2,4,7,9} semitones
 *   from the tonic) when the mode has a major third, 1-b3-4-5-b7
 *   ({0,3,5,7,10}) when minor. The flavour follows the mode's third rather
 *   than `key.minor` so the default minor-key + Ionian state still shows a
 *   coherent five-note set, and the intersection never adds a note outside
 *   the mode (Locrian simply loses its absent natural 5). The toggle is inert
 *   in chord view — chord tones render as-is — but stays enabled: it is a
 *   scale-view setting, not a per-view one.
 * - Chord view follows `hoveredChord`, else the progression's last chord;
 *   with neither it falls back to scale rendering (a dead board reads worse
 *   than a sensible default) plus a one-line hint.
 * - Tonic/root emphasis: the key tonic (scale view) or chord root (chord
 *   view) fills at accent(0.8); other highlighted notes at accent(0.35).
 * - Clicking a dot plays its exact pitch regardless of `soundOn` — a direct
 *   click is explicit intent, same rule as ProgressionBar's Play button. */

import { useMemo, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { TUNINGS, midiToName, tuningById } from '../../../shared/music/tunings';
import { accent } from '../../../shared/theme/accent';
import { SegmentedControl, type SegmentOption } from '../../../shared/ui/SegmentedControl';
import { Select, type SelectOption } from '../../../shared/ui/Select';
import { Toggle } from '../../../shared/ui/Toggle';
import { playNote } from '../lib/audio';
import { MODES, chordPitches, modeScale, spellPitch } from '../lib/theory';
import { setState, useStore } from '../store';
import { pretty } from '../lib/format';

const mod12 = (n: number): number => ((n % 12) + 12) % 12;

/* Neck geometry (SVG user units; the element scales to its container width).
 * Proportions mirror the tuner's neck. */
const FRETS = 12;
const FRET_MARKERS = [3, 5, 7, 9] as const;
const VIEW_W = 520;
const PAD_L = 30; // open-string gutter, left of the nut
const PAD_R = 14;
const PAD_T = 12;
const PAD_B = 16; // fret-number strip
const STRING_GAP = 15;
const DOT_R = 6;

/** Pentatonic degree sets as semitones from the tonic. */
const MAJOR_PENTATONIC = [0, 2, 4, 7, 9];
const MINOR_PENTATONIC = [0, 3, 5, 7, 10];

/* `Select` has no option groups; TUNINGS is already ordered Standard… then
 * Drop…, and every label names its family ("E Standard", "Drop D"), so the
 * flat list reads as grouped — the same list the tuner's picker shows. */
const TUNING_OPTIONS: SelectOption<string>[] = TUNINGS.map((t) => ({
  value: t.id,
  label: t.label,
}));

type FretView = 'scale' | 'chord';

const VIEW_OPTIONS: SegmentOption<FretView>[] = [
  { value: 'scale', label: 'Scale', title: 'Highlight the current scale' },
  { value: 'chord', label: 'Chord', title: 'Highlight the hovered or last progression chord' },
];

type Highlight = {
  /** Pitch classes to light up. */
  pcs: Set<number>;
  /** Pitch class drawn with the strong accent: key tonic or chord root. */
  root: number;
  /** Key-aware spelling per highlighted pitch class. */
  labels: Map<number, string>;
};

export const FretboardHint = () => {
  const tuningId = useStore((s) => s.tuningId);
  const view = useStore((s) => s.fretboardView);
  const pentatonic = useStore((s) => s.pentatonic);
  const hoveredChord = useStore((s) => s.hoveredChord);
  const progression = useStore((s) => s.progression);
  const key = useStore((s) => s.key);
  const mode = useStore((s) => s.mode);

  const tuning = tuningById(tuningId);
  const strings = tuning.strings;
  const n = strings.length;
  const neckW = VIEW_W - PAD_L - PAD_R;
  const neckH = (n - 1) * STRING_GAP;
  const viewH = PAD_T + neckH + PAD_B;

  // Lowest string sits at the bottom (tab convention: high string on top).
  const rowY = (stringIndex: number): number => PAD_T + (n - 1 - stringIndex) * STRING_GAP;
  // Open notes live in the gutter; fretted notes sit between their fret wires.
  const fretX = (fret: number): number =>
    fret === 0 ? PAD_L - 15 : PAD_L + ((fret - 0.5) / FRETS) * neckW;

  /* Chord source: hovered chip wins, else the progression's tail; null means
   * "fall back to scale rendering" (also the whole story in scale view). */
  const chord =
    view === 'chord' ? (hoveredChord ?? progression[progression.length - 1] ?? null) : null;

  /* Highlight sets are memoized per render so the per-cell loop below does
   * Set lookups only — no scale/chord recomputation per dot. */
  const highlight = useMemo<Highlight>(() => {
    if (chord) {
      const pitches = chordPitches(chord); // pitches[0] is the normalized root
      return {
        pcs: new Set(pitches),
        root: pitches[0],
        labels: new Map(pitches.map((p) => [p, spellPitch(p, key)])),
      };
    }
    const modeDef = MODES.find((m) => m.id === mode) ?? MODES[0];
    const scale = modeScale(key.tonic, modeDef);
    const flavour = modeDef.intervals.includes(3) ? MINOR_PENTATONIC : MAJOR_PENTATONIC;
    const penta = new Set(flavour.map((step) => mod12(key.tonic + step)));
    const notes = pentatonic ? scale.filter((note) => penta.has(note.pc)) : scale;
    return {
      pcs: new Set(notes.map((note) => note.pc)),
      root: mod12(key.tonic),
      labels: new Map(notes.map((note) => [note.pc, note.label])),
    };
  }, [chord, key, mode, pentatonic]);

  /* Every lit position for this render — one pass over ≤ 6 × 13 cells. */
  const dots = useMemo(
    () =>
      strings.flatMap((s, stringIndex) =>
        Array.from({ length: FRETS + 1 }, (_, fret) => fret)
          .filter((fret) => highlight.pcs.has(mod12(s.midi + fret)))
          .map((fret) => {
            const midi = s.midi + fret;
            const pc = mod12(midi);
            return { stringIndex, fret, midi, pc, label: highlight.labels.get(pc) ?? '' };
          }),
      ),
    [strings, highlight],
  );

  /* role="button" dots must also activate from the keyboard. */
  const onDotKeyDown = (e: ReactKeyboardEvent<SVGGElement>, midi: number): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      playNote(midi);
    }
  };

  return (
    <section className="flex flex-col gap-1.5 min-w-0" aria-label="Fretboard hints">
      <div className="flex items-center gap-2 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-meta t-tertiary">Tuning</span>
          <Select
            size="sm"
            label="Tuning"
            value={tuningId}
            onChange={(next) => setState({ tuningId: next })}
            options={TUNING_OPTIONS}
          />
        </div>
        <SegmentedControl
          size="sm"
          ariaLabel="Fretboard highlight"
          value={view}
          onChange={(next) => setState({ fretboardView: next })}
          options={VIEW_OPTIONS}
        />
        <label className="ml-auto flex items-center gap-1.5 t-secondary text-meta select-none cursor-pointer">
          <span>Pentatonic</span>
          <Toggle
            checked={pentatonic}
            onChange={(next) => setState({ pentatonic: next })}
            label="Pentatonic"
          />
        </label>
      </div>

      <svg
        viewBox={`0 0 ${VIEW_W} ${viewH}`}
        className="circle-fretboard"
        role="group"
        aria-label="Fretboard"
      >
        {/* Fret wires (1..FRETS). Fret 0 is the thicker nut. */}
        {Array.from({ length: FRETS }, (_, i) => i + 1).map((fret) => {
          const x = PAD_L + (fret / FRETS) * neckW;
          return (
            <line
              key={fret}
              x1={x}
              y1={PAD_T - 3}
              x2={x}
              y2={PAD_T + neckH + 3}
              stroke="var(--hairline)"
              strokeWidth={1}
            />
          );
        })}
        <line
          x1={PAD_L}
          y1={PAD_T - 4}
          x2={PAD_L}
          y2={PAD_T + neckH + 4}
          stroke="var(--fg-faint)"
          strokeWidth={2.5}
          strokeLinecap="round"
        />

        {/* Inlay dots, centred between the middle strings; double at 12. */}
        {[...FRET_MARKERS, FRETS].map((fret) => {
          const x = PAD_L + ((fret - 0.5) / FRETS) * neckW;
          const cy = PAD_T + neckH / 2;
          if (fret === FRETS) {
            return (
              <g key={fret}>
                <circle cx={x} cy={cy - STRING_GAP} r={2.2} fill="var(--fg-ghost)" />
                <circle cx={x} cy={cy + STRING_GAP} r={2.2} fill="var(--fg-ghost)" />
              </g>
            );
          }
          return <circle key={fret} cx={x} cy={cy} r={2.4} fill="var(--fg-ghost)" />;
        })}

        {/* String lines (lower = thicker) + open-string names in the gutter.
            A lit open string skips its gutter label — the dot at fret 0
            renders on the same spot with the key-aware spelling. */}
        {strings.map((s, i) => {
          const y = rowY(i);
          const openLit = highlight.pcs.has(mod12(s.midi));
          return (
            <g key={s.midi}>
              <line
                x1={PAD_L}
                y1={y}
                x2={PAD_L + neckW}
                y2={y}
                stroke="var(--hairline-strong)"
                strokeWidth={0.8 + ((n - 1 - i) / Math.max(1, n - 1)) * 0.7}
              />
              {!openLit && (
                <text x={PAD_L - 15} y={y + 3.5} className="circle-fret-string-label" textAnchor="middle">
                  {pretty(s.name.replace(/\d+$/, ''))}
                </text>
              )}
            </g>
          );
        })}

        {/* Fret numbers. */}
        {[0, ...FRET_MARKERS, FRETS].map((fret) => {
          const x = fret === 0 ? PAD_L : PAD_L + (fret / FRETS) * neckW;
          return (
            <text key={fret} x={x} y={viewH - 4} className="circle-fret-num" textAnchor="middle">
              {fret}
            </text>
          );
        })}

        {/* Highlighted notes. Click (or Enter/Space) plays the exact pitch. */}
        {dots.map((d) => {
          const x = fretX(d.fret);
          const y = rowY(d.stringIndex);
          const isRoot = d.pc === highlight.root;
          return (
            <g
              key={`${d.stringIndex}-${d.fret}`}
              className="circle-fret-dot"
              role="button"
              tabIndex={0}
              aria-label={`Play ${midiToName(d.midi)} (string ${n - d.stringIndex}, fret ${d.fret})`}
              onClick={() => playNote(d.midi)}
              onKeyDown={(e) => onDotKeyDown(e, d.midi)}
            >
              {/* Opaque backing so wires and the nut don't bleed through the tint. */}
              <circle cx={x} cy={y} r={DOT_R} fill="var(--bg-pane)" />
              <circle cx={x} cy={y} r={DOT_R} fill={accent(isRoot ? 0.8 : 0.35)} />
              <text x={x} y={y + 2.5} textAnchor="middle">
                {pretty(d.label)}
              </text>
            </g>
          );
        })}
      </svg>

      {view === 'chord' && !chord && (
        <p className="text-meta t-tertiary">
          No chord yet — hover a chord chip or add one to the progression; showing the scale.
        </p>
      )}
    </section>
  );
};
