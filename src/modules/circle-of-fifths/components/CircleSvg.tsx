/* Interactive SVG circle of fifths — three rings of 12 annular sectors:
 * majors outside, relative minors in the middle, a thin key-signature ring
 * inside. Clicking a sector selects that key (major or relative minor) and
 * rotates it to 12 o'clock; the wheel can also be spun freely with the
 * scroll wheel and reset with a double-click on the background.
 *
 * All geometry (36 paths + label anchors) is precomputed once at module
 * load — a render only assembles styles, so re-renders stay cheap. */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { accent } from '../../../shared/theme/accent';
import { chordMidis, playChord } from '../lib/audio';
import { CIRCLE, MODES, keyAt, keySignature, modeScale, relativeOf, type Key } from '../lib/theory';
import { getState, setState, useStore } from '../store';

/* ─── Geometry ──────────────────────────────────────────────────────────── */

const CX = 200;
const CY = 200;
/** [inner, outer] radii of the three rings. */
const R_MAJOR: [number, number] = [132, 196];
const R_MINOR: [number, number] = [84, 132];
const R_SIG: [number, number] = [64, 84];
/** Radii where the ring labels sit (mid-ring). */
const LABEL_R_MAJOR = 164;
const LABEL_R_MINOR = 108;
const LABEL_R_SIG = 74;
const SLOT_DEG = 30;
/** Angular half-gap between adjacent sectors, for a hairline separation. */
const HALF_GAP_DEG = 0.7;

const mod12 = (n: number): number => ((n % 12) + 12) % 12;

/** Point at `deg` degrees clockwise from 12 o'clock, `r` away from centre. */
const polar = (cx: number, cy: number, r: number, deg: number): [number, number] => {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
};

/** Annular sector between radii r0 < r1 spanning angles a0 → a1 (degrees,
 * clockwise from 12 o'clock). Sectors here span 30°, so large-arc is 0. */
const sectorPath = (
  cx: number,
  cy: number,
  r0: number,
  r1: number,
  a0: number,
  a1: number,
): string => {
  const [x0, y0] = polar(cx, cy, r1, a0);
  const [x1, y1] = polar(cx, cy, r1, a1);
  const [x2, y2] = polar(cx, cy, r0, a1);
  const [x3, y3] = polar(cx, cy, r0, a0);
  const large = a1 - a0 > 180 ? 1 : 0;
  return [
    `M ${x0.toFixed(2)} ${y0.toFixed(2)}`,
    `A ${r1} ${r1} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`,
    `L ${x2.toFixed(2)} ${y2.toFixed(2)}`,
    `A ${r0} ${r0} 0 ${large} 0 ${x3.toFixed(2)} ${y3.toFixed(2)}`,
    'Z',
  ].join(' ');
};

type SlotDatum = {
  majorPath: string;
  minorPath: string;
  sigPath: string;
  majorPos: [number, number];
  minorPos: [number, number];
  sigPos: [number, number];
  majorText: string;
  minorText: string;
  sigText: string;
  majorAria: string;
  minorAria: string;
  majorTip: string;
  minorTip: string;
};

/** Static geometry + labels for the 12 slots, computed once at module load. */
const SLOTS: SlotDatum[] = CIRCLE.map((entry, i) => {
  const a0 = i * SLOT_DEG - SLOT_DEG / 2 + HALF_GAP_DEG;
  const a1 = i * SLOT_DEG + SLOT_DEG / 2 - HALF_GAP_DEG;
  const mid = i * SLOT_DEG;
  const sig = keySignature(keyAt(i, false));
  const sigText = sig.sharps > 0 ? `${sig.sharps}♯` : sig.flats > 0 ? `${sig.flats}♭` : '0';
  /* Spoken signature for aria-labels, so keyboard/AT users get the same
   * information the hover tooltip shows. */
  const sigSpoken =
    sig.sharps > 0
      ? `${sig.sharps} sharp${sig.sharps > 1 ? 's' : ''}`
      : sig.flats > 0
        ? `${sig.flats} flat${sig.flats > 1 ? 's' : ''}`
        : 'no sharps or flats';
  const minorName = entry.minor.label.slice(0, -1); // 'Am' → 'A'
  return {
    majorPath: sectorPath(CX, CY, R_MAJOR[0], R_MAJOR[1], a0, a1),
    minorPath: sectorPath(CX, CY, R_MINOR[0], R_MINOR[1], a0, a1),
    sigPath: sectorPath(CX, CY, R_SIG[0], R_SIG[1], a0, a1),
    majorPos: polar(CX, CY, LABEL_R_MAJOR, mid),
    minorPos: polar(CX, CY, LABEL_R_MINOR, mid),
    sigPos: polar(CX, CY, LABEL_R_SIG, mid),
    majorText: entry.major.label,
    minorText: entry.minor.label,
    sigText,
    majorAria: `${entry.major.label} major, ${sigSpoken}`,
    minorAria: `${minorName} minor, ${sigSpoken}`,
    majorTip: `${entry.major.label} major · ${sigText}`,
    minorTip: `${minorName} minor · ${sigText}`,
  };
});

/** Circle slot of each major pitch class (pc → slot lookup). */
const MAJOR_SLOT_BY_PC: number[] = (() => {
  const slots = new Array<number>(12).fill(0);
  CIRCLE.forEach((entry, i) => {
    slots[entry.major.pc] = i;
  });
  return slots;
})();

/** Slot a key lives in: its own tonic for majors, the relative major's for minors. */
const slotOfKey = (key: Key): number =>
  MAJOR_SLOT_BY_PC[key.minor ? relativeOf(key).tonic : key.tonic];

/* ─── Interaction constants ─────────────────────────────────────────────── */

/** Accumulated wheel deltaY that advances one slot, plus a short lock so a
 * fast trackpad flick steps once instead of spinning the wheel wildly. */
const WHEEL_STEP = 40;
const WHEEL_LOCK_MS = 140;
/** Idle gap after which sub-threshold wheel residue is stale and dropped,
 * so a leftover +35 from one gesture can't make a later +5 fire a step. */
const WHEEL_IDLE_RESET_MS = 200;
/** Sector-click audition is quieter than progression playback (0.18). */
const QUIET_GAIN = 0.12;

/** Quiet audition of the key's tonic triad; silent while sound is off. */
const playTonicTriad = (key: Key): void => {
  if (!getState().soundOn) return;
  playChord(chordMidis({ root: key.tonic, quality: key.minor ? 'min' : 'maj' }), {
    gain: QUIET_GAIN,
  });
};

type CircleSvgProps = {
  /** ⌥-click on a key sector. Reserved for "transpose progression here"
   * (wired by the key panel later); ⌥-click never changes the selection. */
  onAltSelect?: (slot: number) => void;
};

export const CircleSvg = ({ onAltSelect }: CircleSvgProps) => {
  const selectedKey = useStore((s) => s.key);
  const mode = useStore((s) => s.mode);
  const rotation = useStore((s) => s.rotation);

  const svgRef = useRef<SVGSVGElement | null>(null);
  /* Stable prefix for sector ids — they feed the root's aria-activedescendant. */
  const baseId = useId();

  /* Continuous rotation angle. The store keeps `rotation` as a slot index
   * (0–11); animating `-rotation * 30` directly would spin the long way
   * around on an 11 → 0 wrap, so we accumulate an unbounded angle that
   * always takes the shortest arc to the target slot. */
  const [angle, setAngle] = useState(() => -getState().rotation * SLOT_DEG);
  useEffect(() => {
    setAngle((prev) => {
      let delta = (-rotation * SLOT_DEG - prev) % 360;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      return prev + delta;
    });
  }, [rotation]);

  /* Wheel spins the rotor one slot per notch. React's root-level wheel
   * listener is passive, so preventDefault (to stop the page scrolling
   * underneath) needs a native non-passive listener. */
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    let acc = 0;
    let lockedUntil = 0;
    let lastWheelAt = 0;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const now = performance.now();
      if (now < lockedUntil) return;
      /* Stale residue never carries over: a fresh gesture (idle gap) or a
       * direction reversal restarts accumulation from zero, so reversals
       * step immediately and old sub-threshold deltas can't fire early. */
      if (now - lastWheelAt > WHEEL_IDLE_RESET_MS) acc = 0;
      if (acc !== 0 && acc * e.deltaY < 0) acc = 0;
      lastWheelAt = now;
      acc += e.deltaY;
      if (Math.abs(acc) < WHEEL_STEP) return;
      const dir = acc > 0 ? 1 : -1;
      acc = 0;
      lockedUntil = now + WHEEL_LOCK_MS;
      setState((s) => ({ rotation: mod12(s.rotation + dir) }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /* Hover tooltip: SVG sectors can't be wrapped in a positioned div, so a
   * floating fixed div (project `.tip-label` look) follows the pointer.
   * Position updates go straight to the DOM node via a ref — only crossing
   * a sector boundary (text change) causes a React re-render. */
  const [tipText, setTipText] = useState<string | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const tipPos = useRef({ x: 0, y: 0 });

  const placeTip = useCallback((e: ReactMouseEvent): void => {
    tipPos.current = { x: e.clientX + 12, y: e.clientY + 16 };
    const el = tipRef.current;
    if (el) {
      el.style.left = `${tipPos.current.x}px`;
      el.style.top = `${tipPos.current.y}px`;
    }
  }, []);
  const showTip = useCallback(
    (text: string, e: ReactMouseEvent): void => {
      placeTip(e);
      setTipText(text);
    },
    [placeTip],
  );
  const hideTip = useCallback((): void => setTipText(null), []);

  const onSectorClick = useCallback(
    (slot: number, minor: boolean, altKey: boolean): void => {
      if (altKey) {
        onAltSelect?.(slot);
        return;
      }
      const key = keyAt(slot, minor);
      setState({ key, rotation: slot }); // selection always lands on top
      playTonicTriad(key);
    },
    [onAltSelect],
  );

  /* Sectors are not tab stops, but a mouse click still focuses them
   * (tabIndex={-1}); Enter/Space on a click-focused sector must activate. */
  const onSectorKeyDown = useCallback(
    (e: ReactKeyboardEvent<SVGPathElement>, slot: number, minor: boolean): void => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSectorClick(slot, minor, e.altKey);
      }
    },
    [onSectorClick],
  );

  /* Svg root: ←/→ walk the selection around the circle in the current ring
   * (silently — Enter is the audition key). Enter only acts when the root
   * itself is focused; a focused sector handles its own Enter above. */
  const onRootKeyDown = (e: ReactKeyboardEvent<SVGSVGElement>): void => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const current = getState().key;
      const slot = mod12(slotOfKey(current) + (e.key === 'ArrowRight' ? 1 : -1));
      setState({ key: keyAt(slot, current.minor), rotation: slot });
    } else if (e.key === 'Enter' && e.target === e.currentTarget) {
      playTonicTriad(getState().key);
    }
  };

  /* Diatonic arc: the seven slots whose MAJOR-ring pitch class belongs to
   * the current mode's scale on the selected tonic. Any diatonic scale is
   * seven consecutive fifths, so this is always a contiguous arc; both
   * rings at those slots count as inside it (the classic wedge overlay).
   * Stored as a 12-bit mask — a primitive, so it memoizes cleanly. */
  const diatonicMask = useMemo(() => {
    const modeDef = MODES.find((m) => m.id === mode) ?? MODES[0];
    return modeScale(selectedKey.tonic, modeDef).reduce(
      (mask, note) => mask | (1 << MAJOR_SLOT_BY_PC[note.pc]),
      0,
    );
  }, [selectedKey.tonic, mode]);

  const selectedSlot = slotOfKey(selectedKey);
  const selectedMinor = selectedKey.minor;

  /* The rotor subtree (36 paths + 36 labels) only depends on the angle and
   * the highlight inputs — memoized so tooltip show/hide re-renders skip it. */
  const rotor = useMemo(() => {
    const counterRotate: CSSProperties = { transform: `rotate(${-angle}deg)` };
    const prevSlot = mod12(selectedSlot - 1);
    const nextSlot = mod12(selectedSlot + 1);

    /* Highlight ladder: selected key > dominant/subdominant neighbours in
     * the same ring > relative key in the other ring. Everything outside
     * the diatonic arc dims; arc membership is marked via data-arc so the
     * CSS stroke stays overridable by :focus-visible. */
    const sectorStyle = (slot: number, minorRing: boolean): CSSProperties => {
      const sameRing = minorRing === selectedMinor;
      const fill =
        sameRing && slot === selectedSlot
          ? accent(0.55)
          : sameRing && (slot === prevSlot || slot === nextSlot)
            ? accent(0.3)
            : !sameRing && slot === selectedSlot
              ? accent(0.22)
              : undefined;
      const inArc = ((diatonicMask >> slot) & 1) === 1;
      return { fill, opacity: fill !== undefined || inArc ? undefined : 0.45 };
    };

    const inArc = (slot: number): boolean => ((diatonicMask >> slot) & 1) === 1;

    return (
      <g className="circle-rotor" style={{ transform: `rotate(${angle}deg)` }}>
        {SLOTS.map((slot, i) => {
          const majorStyle = sectorStyle(i, false);
          const minorStyle = sectorStyle(i, true);
          return (
            <g key={slot.majorText}>
              <path
                id={`${baseId}-major-${i}`}
                d={slot.majorPath}
                className="circle-sector"
                data-arc={inArc(i) ? 'true' : undefined}
                role="button"
                tabIndex={-1}
                aria-label={slot.majorAria}
                aria-pressed={!selectedMinor && i === selectedSlot}
                style={majorStyle}
                onClick={(e) => e.detail === 1 && onSectorClick(i, false, e.altKey)}
                onKeyDown={(e) => onSectorKeyDown(e, i, false)}
                onMouseEnter={(e) => showTip(slot.majorTip, e)}
                onMouseMove={placeTip}
                onMouseLeave={hideTip}
              />
              <path
                id={`${baseId}-minor-${i}`}
                d={slot.minorPath}
                className="circle-sector"
                data-arc={inArc(i) ? 'true' : undefined}
                role="button"
                tabIndex={-1}
                aria-label={slot.minorAria}
                aria-pressed={selectedMinor && i === selectedSlot}
                style={minorStyle}
                onClick={(e) => e.detail === 1 && onSectorClick(i, true, e.altKey)}
                onKeyDown={(e) => onSectorKeyDown(e, i, true)}
                onMouseEnter={(e) => showTip(slot.minorTip, e)}
                onMouseMove={placeTip}
                onMouseLeave={hideTip}
              />
              <path d={slot.sigPath} className="circle-sig-sector" aria-hidden="true" />
              <text
                x={slot.majorPos[0]}
                y={slot.majorPos[1]}
                className="circle-label circle-major-label"
                textAnchor="middle"
                dominantBaseline="central"
                style={{ ...counterRotate, opacity: majorStyle.opacity }}
                aria-hidden="true"
              >
                {slot.majorText}
              </text>
              <text
                x={slot.minorPos[0]}
                y={slot.minorPos[1]}
                className="circle-label circle-minor-label"
                textAnchor="middle"
                dominantBaseline="central"
                style={{ ...counterRotate, opacity: minorStyle.opacity }}
                aria-hidden="true"
              >
                {slot.minorText}
              </text>
              <text
                x={slot.sigPos[0]}
                y={slot.sigPos[1]}
                className="circle-label circle-sig-label"
                textAnchor="middle"
                dominantBaseline="central"
                style={counterRotate}
                aria-hidden="true"
              >
                {slot.sigText}
              </text>
            </g>
          );
        })}
      </g>
    );
  }, [
    angle,
    baseId,
    selectedSlot,
    selectedMinor,
    diatonicMask,
    onSectorClick,
    onSectorKeyDown,
    showTip,
    placeTip,
    hideTip,
  ]);

  /* Single-tab-stop composite widget (aria-activedescendant variant): the
   * root is the only tab stop, sectors are tabIndex={-1}, and the root
   * points at the selected sector via aria-activedescendant — 25 sequential
   * tab stops would make the wheel a keyboard wall. Roving tabindex was the
   * alternative, but here the "cursor" IS the selection, so keeping DOM
   * focus on the root (which already owns ←/→ and Enter) is simpler and
   * avoids re-focusing paths inside a rotating subtree. While the root
   * shows :focus-visible, CSS gives the selected (aria-pressed) sector a
   * strong stroke so the active descendant is visible. role="group"
   * supports aria-activedescendant per ARIA 1.2. */
  const activeDescendant = `${baseId}-${selectedMinor ? 'minor' : 'major'}-${selectedSlot}`;

  return (
    <>
      <svg
        ref={svgRef}
        viewBox="0 0 400 400"
        className="circle-svg"
        role="group"
        aria-label="Circle of fifths"
        aria-activedescendant={activeDescendant}
        tabIndex={0}
        onKeyDown={onRootKeyDown}
        onMouseLeave={hideTip}
      >
        {/* Background catcher: double-click anywhere off the key sectors
            snaps the rotor back to C-on-top. */}
        <rect
          x={0}
          y={0}
          width={400}
          height={400}
          fill="transparent"
          aria-hidden="true"
          onDoubleClick={() => setState({ rotation: 0 })}
        />
        {rotor}
      </svg>
      {tipText !== null &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            className="tip-label"
            style={{
              position: 'fixed',
              left: tipPos.current.x,
              top: tipPos.current.y,
              zIndex: 9999,
              pointerEvents: 'none',
            }}
          >
            {tipText}
          </div>,
          document.body,
        )}
    </>
  );
};
