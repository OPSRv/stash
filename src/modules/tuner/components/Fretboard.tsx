import type { TunerReading } from '../hooks/useTuner';
import {
  FRET_MARKERS,
  FRETBOARD_FRETS,
  fretPositionsForMidi,
  midiToName,
  type Tuning,
} from '../tuner.constants';

/* Chromatic fretboard for the big tuner. Two stacked elements:
 *
 *   1. A chromatic ribbon — the detected note centred between its neighbours,
 *      so the player sees what's a semitone either side at a glance.
 *   2. A horizontal neck — the selected tuning's open strings labelled at the
 *      nut (the *targets*), with the detected note lit at every fret position
 *      it lives on. This is what frees the tuner from a single tuning: it names
 *      and places any note you play, while the tuning is just the overlay of
 *      where you're aiming.
 *
 * Pure presentational SVG (mirrors `TunerMeter`'s approach) driven by the live
 * reading. */

type Props = {
  tuning: Tuning;
  reading: TunerReading;
  /** A pitch is currently detected. */
  hasPitch: boolean;
  /** The detected note sits within the in-tune window. */
  inTune: boolean;
};

const GREEN = '#3ddc97';
const AMBER = '#f5a623';
const DIM = '#41506280';

// Neck geometry (SVG user units; the element scales to its container width).
const VIEW_W = 520;
const PAD_L = 30; // open-string label gutter, left of the nut
const PAD_R = 14;
const PAD_T = 12;
const PAD_B = 16; // fret-number strip
const STRING_GAP = 15;

const RIBBON_SPAN = 3; // cells either side of the centre → 7 total

export const Fretboard = ({ tuning, reading, hasPitch, inTune }: Props) => {
  const strings = tuning.strings;
  const n = strings.length;
  const neckW = VIEW_W - PAD_L - PAD_R;
  const neckH = (n - 1) * STRING_GAP;
  const viewH = PAD_T + neckH + PAD_B;
  const tone = inTune ? GREEN : AMBER;

  // Lowest string sits at the bottom (tab convention: high string on top).
  const rowY = (stringIndex: number) => PAD_T + (n - 1 - stringIndex) * STRING_GAP;
  // Open notes live in the gutter; fretted notes sit between their fret wires.
  const fretX = (fret: number) =>
    fret === 0 ? PAD_L - 15 : PAD_L + ((fret - 0.5) / FRETBOARD_FRETS) * neckW;

  const lit = hasPitch && reading.midi >= 0;
  const positions = lit ? fretPositionsForMidi(reading.midi, tuning) : [];
  const litLetter = (mi: number) => midiToName(mi).replace(/\d+$/, '');

  return (
    <div className="tuner-fretboard">
      {/* Chromatic ribbon — neighbours of the detected note. */}
      <div className="tuner-ribbon" aria-hidden="true">
        {Array.from({ length: RIBBON_SPAN * 2 + 1 }, (_, k) => {
          const offset = k - RIBBON_SPAN;
          const cur = offset === 0;
          const label = lit ? litLetter(reading.midi + offset) : cur ? '–' : '·';
          return (
            <span
              key={k}
              className="tuner-ribbon-cell"
              data-cur={cur || undefined}
              data-tuned={(cur && inTune) || undefined}
            >
              {label}
            </span>
          );
        })}
      </div>

      <svg
        viewBox={`0 0 ${VIEW_W} ${viewH}`}
        className="tuner-fretboard-neck w-full"
        aria-hidden="true"
      >
        {/* Fret wires (1..FRETS). Fret 0 is the thicker nut. */}
        {Array.from({ length: FRETBOARD_FRETS }, (_, i) => {
          const fret = i + 1;
          const x = PAD_L + (fret / FRETBOARD_FRETS) * neckW;
          return (
            <line
              key={fret}
              x1={x}
              y1={PAD_T - 3}
              x2={x}
              y2={PAD_T + neckH + 3}
              stroke="rgba(255,255,255,0.08)"
              strokeWidth={1}
            />
          );
        })}
        <line
          x1={PAD_L}
          y1={PAD_T - 4}
          x2={PAD_L}
          y2={PAD_T + neckH + 4}
          stroke="#5d7088"
          strokeWidth={2.5}
          strokeLinecap="round"
        />

        {/* Inlay dots, centred vertically between the middle strings. */}
        {[...FRET_MARKERS, FRETBOARD_FRETS].map((fret) => {
          const x = PAD_L + ((fret - 0.5) / FRETBOARD_FRETS) * neckW;
          const cy = PAD_T + neckH / 2;
          if (fret === FRETBOARD_FRETS) {
            return (
              <g key={fret}>
                <circle cx={x} cy={cy - STRING_GAP} r={2.2} fill="#2b3744" />
                <circle cx={x} cy={cy + STRING_GAP} r={2.2} fill="#2b3744" />
              </g>
            );
          }
          return <circle key={fret} cx={x} cy={cy} r={2.4} fill="#2b3744" />;
        })}

        {/* String lines + open-string note labels (the tuning's targets). */}
        {strings.map((s, i) => {
          const y = rowY(i);
          const letter = s.name.replace(/\d+$/, '');
          // Highlight the target whose open note is exactly what we hear.
          const targetHit = lit && s.midi === reading.midi;
          const labelColor = targetHit ? tone : DIM;
          return (
            <g key={s.midi}>
              <line
                x1={PAD_L}
                y1={y}
                x2={PAD_L + neckW}
                y2={y}
                stroke="rgba(255,255,255,0.12)"
                strokeWidth={0.9 + (i / Math.max(1, n - 1)) * 0.8}
              />
              <text
                x={PAD_L - 15}
                y={y + 4}
                fill={labelColor}
                fontSize={12}
                fontWeight={700}
                fontFamily="var(--font-mono)"
                textAnchor="middle"
                style={targetHit ? { filter: `drop-shadow(0 0 5px ${tone})` } : undefined}
              >
                {letter}
              </text>
            </g>
          );
        })}

        {/* Fret numbers. */}
        {[0, ...FRET_MARKERS, FRETBOARD_FRETS].map((fret) => {
          const x = fret === 0 ? PAD_L : PAD_L + (fret / FRETBOARD_FRETS) * neckW;
          return (
            <text
              key={fret}
              x={x}
              y={viewH - 4}
              fill="#3a4452"
              fontSize={9}
              fontFamily="var(--font-mono)"
              textAnchor="middle"
            >
              {fret}
            </text>
          );
        })}

        {/* The detected note, lit at every position it lives on the neck. */}
        {positions.map(({ stringIndex, fret }) => {
          const x = fretX(fret);
          const y = rowY(stringIndex);
          return (
            <g key={`${stringIndex}-${fret}`}>
              <circle cx={x} cy={y} r={7.5} fill={tone} opacity={0.22} />
              <circle
                cx={x}
                cy={y}
                r={5.5}
                fill={tone}
                stroke="#0e1218"
                strokeWidth={0.8}
                style={{ filter: `drop-shadow(0 0 5px ${tone})` }}
              />
              <text
                x={x}
                y={y + 3}
                fill="#0e1218"
                fontSize={8}
                fontWeight={800}
                fontFamily="var(--font-mono)"
                textAnchor="middle"
              >
                {litLetter(reading.midi)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
};
