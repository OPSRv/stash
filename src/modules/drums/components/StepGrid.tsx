/* The step sequencer grid: one row per voice (label = audition, mute,
 * volume), one cell per step.
 *
 * Interaction
 *  - click toggles a hit, ⌥-click toggles an accent; press-and-drag paints
 *    the first cell's new value across the cells you sweep.
 *  - keyboard: roving tabindex over the cells (one Tab stop for the whole
 *    grid); arrows / Home / End move, Space/Enter toggle, `A` accents.
 *  - the playhead is painted by toggling a class on the sounding column via
 *    the DOM, not React state — no re-render of 256 cells per 16th note. */

import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { IconButton } from '../../../shared/ui/IconButton';
import { RangeSlider } from '../../../shared/ui/RangeSlider';
import { SpeakerIcon } from '../../../shared/ui/icons';
import { VOICE_LABELS, VOICES, type DrumVoice, type DrumsState, type Step, type VoiceMix } from '../lib/model';

type Props = {
  state: DrumsState;
  stepsPerBeat: number;
  stepsPerBar: number;
  isPlaying: boolean;
  onCell: (voice: DrumVoice, col: number, value: Step) => void;
  onMix: (voice: DrumVoice, patch: Partial<VoiceMix>) => void;
  onPreview: (voice: DrumVoice) => void;
  subscribeStep: (cb: (col: number) => void) => () => void;
};

/** Value a click / keypress produces. Plain toggle: off → hit, else off.
 *  Accent toggle: accent → hit, else accent. */
const nextValue = (cur: Step, accent: boolean): Step =>
  accent ? (cur === 2 ? 1 : 2) : cur === 0 ? 1 : 0;

const STEP_NAMES: Record<Step, string> = { 0: 'off', 1: 'hit', 2: 'accent' };

export const StepGrid = ({
  state,
  stepsPerBeat,
  stepsPerBar,
  isPlaying,
  onCell,
  onMix,
  onPreview,
  subscribeStep,
}: Props) => {
  const gridRef = useRef<HTMLDivElement>(null);
  const len = state.steps.kick.length;
  const [focus, setFocus] = useState<[number, number]>([0, 0]);
  const paintRef = useRef<Step | null>(null);

  // Keep the roving focus inside the grid when the pattern shrinks.
  const fRow = focus[0];
  const fCol = Math.min(focus[1], len - 1);

  // Playhead — class toggling on the sounding column.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const clear = () =>
      grid.querySelectorAll('.is-playhead').forEach((el) => el.classList.remove('is-playhead'));
    if (!isPlaying) {
      clear();
      return;
    }
    const unsub = subscribeStep((col) => {
      clear();
      grid.querySelectorAll(`[data-col="${col}"]`).forEach((el) => el.classList.add('is-playhead'));
    });
    return () => {
      unsub();
      clear();
    };
  }, [isPlaying, subscribeStep]);

  // End a paint stroke wherever the pointer is released.
  useEffect(() => {
    const end = () => {
      paintRef.current = null;
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, []);

  const focusCell = useCallback((row: number, col: number) => {
    setFocus([row, col]);
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`button[data-row="${row}"][data-col="${col}"]`)
      ?.focus();
  }, []);

  const onCellPointerDown = (voice: DrumVoice, row: number, col: number, e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault(); // keep the drag from selecting text
    const v = nextValue(state.steps[voice][col], e.altKey);
    paintRef.current = v;
    onCell(voice, col, v);
    focusCell(row, col);
  };

  const onCellPointerEnter = (voice: DrumVoice, col: number, e: PointerEvent) => {
    if (paintRef.current === null || (e.buttons & 1) === 0) return;
    if (state.steps[voice][col] !== paintRef.current) onCell(voice, col, paintRef.current);
  };

  const onCellKeyDown = (voice: DrumVoice, row: number, col: number, e: KeyboardEvent) => {
    const move = (r: number, c: number) => {
      e.preventDefault();
      focusCell(Math.max(0, Math.min(VOICES.length - 1, r)), Math.max(0, Math.min(len - 1, c)));
    };
    switch (e.key) {
      case 'ArrowRight':
        return move(row, col + 1);
      case 'ArrowLeft':
        return move(row, col - 1);
      case 'ArrowDown':
        return move(row + 1, col);
      case 'ArrowUp':
        return move(row - 1, col);
      case 'Home':
        return move(row, 0);
      case 'End':
        return move(row, len - 1);
      case ' ':
      case 'Enter':
        e.preventDefault();
        e.stopPropagation(); // Space here edits, it doesn't toggle playback
        return onCell(voice, col, nextValue(state.steps[voice][col], false));
      case 'a':
      case 'A':
        e.preventDefault();
        return onCell(voice, col, nextValue(state.steps[voice][col], true));
    }
  };

  return (
    <div
      ref={gridRef}
      role="grid"
      aria-label="Drum pattern"
      aria-rowcount={VOICES.length}
      aria-colcount={len}
      className="drums-grid flex min-h-0 flex-1 flex-col gap-1.5"
    >
      {VOICES.map((voice, row) => (
        <div
          key={voice}
          role="row"
          data-muted={state.mix[voice].muted || undefined}
          className="flex min-h-0 flex-1 items-center gap-2"
        >
          <VoiceStrip
            voice={voice}
            mix={state.mix[voice]}
            onMix={onMix}
            onPreview={onPreview}
          />
          <div className="flex h-full min-w-0 flex-1 gap-[3px]">
            {state.steps[voice].map((step, col) => {
              const groupStart = col > 0 && col % stepsPerBeat === 0;
              const barStart = col > 0 && col % stepsPerBar === 0;
              const shaded = Math.floor(col / stepsPerBeat) % 2 === 1;
              return (
                <div
                  key={col}
                  role="gridcell"
                  className={`flex min-w-0 flex-1 ${barStart ? 'ml-3' : groupStart ? 'ml-1.5' : ''}`}
                >
                  <button
                    type="button"
                    data-row={row}
                    data-col={col}
                    data-step={step}
                    data-shaded={shaded || undefined}
                    tabIndex={row === fRow && col === fCol ? 0 : -1}
                    aria-pressed={step > 0}
                    aria-label={`${VOICE_LABELS[voice]} step ${col + 1}: ${STEP_NAMES[step]}`}
                    className="drum-cell ring-focus"
                    onPointerDown={(e) => onCellPointerDown(voice, row, col, e)}
                    onPointerEnter={(e) => onCellPointerEnter(voice, col, e)}
                    onKeyDown={(e) => onCellKeyDown(voice, row, col, e)}
                    onFocus={() => setFocus([row, col])}
                    // Assistive-tech activation (VoiceOver) clicks without a
                    // pointerdown; real mouse clicks were handled above.
                    onClick={(e) => {
                      if (e.detail === 0) onCell(voice, col, nextValue(step, e.altKey));
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};

type StripProps = {
  voice: DrumVoice;
  mix: VoiceMix;
  onMix: (voice: DrumVoice, patch: Partial<VoiceMix>) => void;
  onPreview: (voice: DrumVoice) => void;
};

/** Row header: audition button, mute, volume. Memoised — only re-renders
 *  when its own voice's mix changes. */
const VoiceStrip = memo(({ voice, mix, onMix, onPreview }: StripProps) => (
  <div role="rowheader" className="flex w-[150px] shrink-0 items-center gap-1">
    <button
      type="button"
      className="drum-voice-name ring-focus text-meta"
      onClick={() => onPreview(voice)}
      aria-label={`Preview ${VOICE_LABELS[voice]}`}
    >
      {VOICE_LABELS[voice]}
    </button>
    <IconButton
      title={mix.muted ? `Unmute ${VOICE_LABELS[voice]}` : `Mute ${VOICE_LABELS[voice]}`}
      active={!mix.muted}
      onClick={() => onMix(voice, { muted: !mix.muted })}
    >
      <SpeakerIcon />
    </IconButton>
    <RangeSlider
      value={Math.round(mix.volume * 100)}
      onChange={(v) => onMix(voice, { volume: v / 100 })}
      label={`${VOICE_LABELS[voice]} volume`}
      disabled={mix.muted}
      className="w-12 min-w-0"
    />
  </div>
));
VoiceStrip.displayName = 'VoiceStrip';
