/** Crisp SVG note glyphs for the subdivision picker. Replaces the Unicode
 *  music symbols (♩ ♪♪ ♬) that render inconsistently across fonts/weights.
 *  All shapes use `currentColor`, so they inherit the button's text colour
 *  (and its active/hover accent states) for free. */

export type NoteKind = 'quarter' | 'eighth' | 'triplet' | 'sixteenth';

const STEM_TOP = 4;
const HEAD_Y = 17.5;
const HEAD_RX = 3.3;
const HEAD_RY = 2.5;
/** Stem attaches just right of the (rotated) head. */
const STEM_DX = 2.8;

const Head = ({ cx }: { cx: number }) => (
  <ellipse
    cx={cx}
    cy={HEAD_Y}
    rx={HEAD_RX}
    ry={HEAD_RY}
    transform={`rotate(-24 ${cx} ${HEAD_Y})`}
    fill="currentColor"
  />
);

const Stem = ({ cx }: { cx: number }) => (
  <line
    x1={cx + STEM_DX}
    y1={HEAD_Y - 1}
    x2={cx + STEM_DX}
    y2={STEM_TOP}
    stroke="currentColor"
    strokeWidth={1.4}
    strokeLinecap="round"
  />
);

const Beam = ({ x1, x2, y }: { x1: number; x2: number; y: number }) => (
  <rect x={x1} y={y} width={x2 - x1} height={2.4} rx={1} fill="currentColor" />
);

type Props = {
  kind: NoteKind;
  size?: number;
};

export const NoteGlyph = ({ kind, size = 18 }: Props) => {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    'aria-hidden': true as const,
    style: { display: 'block' as const },
  };

  if (kind === 'quarter') {
    const cx = 8.5;
    return (
      <svg {...common}>
        <Head cx={cx} />
        <Stem cx={cx} />
      </svg>
    );
  }

  if (kind === 'eighth') {
    const a = 6;
    const b = 15;
    return (
      <svg {...common}>
        <Head cx={a} />
        <Head cx={b} />
        <Stem cx={a} />
        <Stem cx={b} />
        <Beam x1={a + STEM_DX - 0.7} x2={b + STEM_DX + 0.7} y={STEM_TOP} />
      </svg>
    );
  }

  if (kind === 'sixteenth') {
    const a = 6;
    const b = 15;
    return (
      <svg {...common}>
        <Head cx={a} />
        <Head cx={b} />
        <Stem cx={a} />
        <Stem cx={b} />
        <Beam x1={a + STEM_DX - 0.7} x2={b + STEM_DX + 0.7} y={STEM_TOP} />
        <Beam x1={a + STEM_DX - 0.7} x2={b + STEM_DX + 0.7} y={STEM_TOP + 3.4} />
      </svg>
    );
  }

  // triplet — three beamed heads with a small bracketed "3" marker.
  const xs = [3, 10, 17];
  const left = xs[0] + STEM_DX - 0.7;
  const right = xs[2] + STEM_DX + 0.7;
  return (
    <svg {...common}>
      {xs.map((cx) => (
        <Head key={`h${cx}`} cx={cx} />
      ))}
      {xs.map((cx) => (
        <Stem key={`s${cx}`} cx={cx} />
      ))}
      <Beam x1={left} x2={right} y={STEM_TOP + 1.4} />
      <text
        x={(left + right) / 2}
        y={3.2}
        textAnchor="middle"
        fontSize={6}
        fontWeight={700}
        fill="currentColor"
      >
        3
      </text>
    </svg>
  );
};
