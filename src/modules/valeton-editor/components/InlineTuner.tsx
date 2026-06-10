import { useEffect, useRef, useState } from 'react';
import { tunerGetState } from '../../tuner/api';
import { useTuner } from '../../tuner/hooks/useTuner';
import { IN_TUNE_CENTS } from '../../tuner/tuner.constants';

/**
 * Compact always-listening tuner that lives inline in the editor toolbar. It
 * reuses the standalone tuner module's pitch-detection hook (`useTuner`) and
 * the user's saved tuning + input device, so a player can tune without leaving
 * the patch they're editing. Mounting starts the mic; unmounting releases it,
 * so the parent simply renders this only while the inline tuner is engaged.
 *
 * Clicking the readout opens the full tuner modal (`onExpand`) for the big
 * meter, tuning picker and device selector.
 */
export const InlineTuner = ({ onExpand }: { onExpand: () => void }) => {
  const [deviceId, setDeviceId] = useState<string | null>(null);

  const { listening, error, reading, start } = useTuner(deviceId);

  // Hydrate the same saved input device the standalone tuner uses, so both
  // surfaces share the mic without the player re-picking here. (Detection is
  // chromatic, so the tuning no longer affects what note the pill reads.)
  useEffect(() => {
    tunerGetState()
      .then((s) => setDeviceId(s.device_id ?? null))
      .catch(() => {});
  }, []);

  // Engage the mic as soon as the inline tuner appears — `useTuner` releases it
  // again on unmount (when the toolbar toggle turns the tuner off).
  useEffect(() => {
    start();
  }, [start]);

  // A confident lock = a pitch within the meter's ±50¢ window of a string.
  // Readings further out are octave artifacts, low-frequency rumble, or a pitch
  // sitting between strings — never a number worth showing on a tiny meter
  // (the dot would just pin to the edge and the cents read like "−1106").
  const LOCK_CENTS = 50;
  const locked = listening && reading.midi >= 0 && Math.abs(reading.cents) <= LOCK_CENTS;

  // Hold the last *locked* note so brief silences between picks (and a string's
  // decay) don't blank the readout — it just dims (`data-active` off) until the
  // next confident pitch. Crucially we only latch locked frames, so a stray
  // out-of-range reading can never stick. Mutating a ref in render is fine here
  // — it's a local cache with no external effect.
  const heldRef = useRef<{ note: string; cents: number } | null>(null);
  if (locked && reading.note) heldRef.current = { note: reading.note, cents: reading.cents };
  const held = heldRef.current;

  const inTune = locked && held != null && Math.abs(held.cents) <= IN_TUNE_CENTS;
  const noteLetter = held?.note.replace(/\d+$/, '') ?? '–';
  const noteOctave = held?.note.match(/\d+$/)?.[0] ?? '';

  // Fixed-width, always-signed cents so the label never changes size as the
  // value crosses zero or gains a digit (a prime source of the jumping).
  const rounded = held ? Math.round(held.cents) : 0;
  const centsLabel = held ? `${rounded > 0 ? '+' : rounded < 0 ? '−' : '±'}${Math.abs(rounded)}` : '';

  // Dot position across the ±50¢ meter, clamped so wild readings stay on-track.
  const clamped = Math.max(-50, Math.min(50, held?.cents ?? 0));
  const dotLeft = 50 + clamped;

  return (
    <button
      type="button"
      data-id="inline_tuner"
      className="tuner-pill"
      data-tuned={inTune || undefined}
      data-active={locked || undefined}
      title="Open full tuner"
      onClick={onExpand}
    >
      {error ? (
        <span className="tuner-pill-msg">mic?</span>
      ) : (
        <>
          <span className="tuner-pill-note tabular-nums">
            {noteLetter}
            <span className="tuner-pill-oct">{noteOctave}</span>
          </span>
          <span className="tuner-pill-meter" aria-hidden="true">
            <span className="tuner-pill-tick" />
            {held && <span className="tuner-pill-dot" style={{ left: `${dotLeft}%` }} />}
          </span>
          <span className="tuner-pill-cents tabular-nums">{centsLabel}</span>
        </>
      )}
    </button>
  );
};
