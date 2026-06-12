/* Progression bar: transport (play/stop + BPM), preset fill, copy / clear,
 * and the horizontal strip of draggable chord chips. The ⌥-click transpose
 * handler (`transposeTo`) and the playback handle live in `lib/actions` so
 * non-component callers (CircleShell wiring, assistant pushes) share them.
 *
 * Playback note: the Play button is explicit user intent, so it sounds even
 * when `soundOn` is off — that toggle gates only the implicit previews
 * (chip click / wheel audition). BPM edits take effect on the next Play. */

import { useEffect, useState } from 'react';
import { accentSolid } from '../../../shared/theme/accent';
import { IconButton } from '../../../shared/ui/IconButton';
import { NumberInput } from '../../../shared/ui/NumberInput';
import { Select, type SelectOption } from '../../../shared/ui/Select';
import { useToast } from '../../../shared/ui/Toast';
import { CloseIcon, CopyIcon, PlayIcon, StopCircleIcon, TrashIcon } from '../../../shared/ui/icons';
import { copyText } from '../../../shared/util/clipboard';
import { playCurrentProgression, previewChord, stopProgression } from '../lib/actions';
import { pretty } from '../lib/format';
import { PRESETS, presetChords, progressionText } from '../lib/progressions';
import { chordName, romanNumeral } from '../lib/theory';
import { MAX_BPM, MIN_BPM, getState, setState, useStore } from '../store';

/** The empty-value option renders as the trigger placeholder; picking a real
 * preset fills the progression in the current key (re-picking it refills). */
const PRESET_OPTIONS: SelectOption<string>[] = [
  { value: '', label: 'Preset…' },
  ...PRESETS.map((p) => ({ value: p.id, label: p.label })),
];

type DropPos = 'before' | 'after';

export const ProgressionBar = () => {
  const progression = useStore((s) => s.progression);
  const playingIndex = useStore((s) => s.playingIndex);
  const bpm = useStore((s) => s.bpm);
  const key = useStore((s) => s.key);
  const { toast } = useToast();

  /* ── Playback ──────────────────────────────────────────────────────── */

  /* Derived from playingIndex (set by the run's first onStep within one
   * macrotask of Play, cleared by onStep(null) on stop/finish). The brief
   * pre-first-tick window where the button still reads "Play" is harmless:
   * clicking again just restarts the run. */
  const playing = playingIndex !== null;

  useEffect(() => () => stopProgression(), []);

  /* ── Edits ─────────────────────────────────────────────────────────── */

  const [presetId, setPresetId] = useState('');

  const applyPreset = (id: string): void => {
    setPresetId(id);
    if (!id) return;
    stopProgression(); // a sounding run would highlight stale chips
    setState({ progression: presetChords(id, getState().key) });
  };

  const clearProgression = (): void => {
    stopProgression();
    setPresetId('');
    setState({ progression: [] });
  };

  /* Structural edits stop playback: the run plays the snapshot captured at
   * Play time, so the pulse would land on the wrong chip afterwards. */
  const removeAt = (index: number): void => {
    stopProgression();
    setState((s) => ({ progression: s.progression.filter((_, i) => i !== index) }));
  };

  const copyProgression = async (): Promise<void> => {
    const s = getState();
    const ok = await copyText(progressionText(s.progression, s.key));
    toast({
      title: ok ? 'Progression copied' : 'Copy failed',
      variant: ok ? 'success' : 'error',
    });
  };

  /* ── Drag reorder (same HTML5 idiom as the Valeton signal chain) ───── */

  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<{ index: number; pos: DropPos } | null>(null);

  const clearDrag = (): void => {
    setDragIdx(null);
    setDropAt(null);
  };

  const onDrop = (target: number): void => {
    const from = dragIdx;
    const drop = dropAt;
    clearDrag();
    if (from === null || drop === null || drop.index !== target || from === target) return;
    stopProgression(); // see removeAt — reorder desyncs the playing pulse
    setState((s) => {
      const next = [...s.progression];
      const [moved] = next.splice(from, 1);
      // The store is mutable from outside (assistant pushes); if the
      // progression shrank mid-drag, the stale index yields no chord.
      if (!moved) return {};
      let at = drop.index + (drop.pos === 'after' ? 1 : 0);
      if (from < at) at -= 1; // removal above shifted the insertion point
      next.splice(at, 0, moved);
      return { progression: next };
    });
  };

  const empty = progression.length === 0;

  return (
    <section className="flex flex-col gap-1 min-w-0" aria-label="Chord progression">
      <div className="flex items-center gap-1.5 min-w-0">
        <IconButton
          title={playing ? 'Stop' : 'Play progression'}
          onClick={playing ? stopProgression : playCurrentProgression}
          disabled={!playing && empty}
        >
          {playing ? <StopCircleIcon /> : <PlayIcon />}
        </IconButton>
        <NumberInput
          size="sm"
          className="w-24 shrink-0"
          value={bpm}
          onChange={(next) => {
            if (next != null) setState({ bpm: next });
          }}
          min={MIN_BPM}
          max={MAX_BPM}
          suffix="BPM"
          ariaLabel="Tempo in beats per minute"
        />
        <Select
          size="sm"
          label="Fill from preset"
          value={presetId}
          onChange={applyPreset}
          options={PRESET_OPTIONS}
          placement="top"
        />
        <IconButton title="Copy progression" onClick={() => void copyProgression()} disabled={empty}>
          <CopyIcon />
        </IconButton>
        <IconButton title="Clear progression" tone="danger" onClick={clearProgression} disabled={empty}>
          <TrashIcon />
        </IconButton>

        {/* Chip strip — scrolls horizontally past ~6 chords, bar hidden by the
            global scrollbar rules. */}
        <div className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto py-0.5">
          {empty ? (
            <p className="text-meta t-tertiary whitespace-nowrap">
              Click chords in the key panel to build a progression.
            </p>
          ) : (
            progression.map((chord, i) => (
              <div
                // Index keys are fine here: chords carry no identity and the
                // list mutates only via the handlers above.
                key={`${i}-${chord.root}-${chord.quality}`}
                className={`group relative flex items-center shrink-0 cursor-grab ${
                  dragIdx === i ? 'opacity-50' : ''
                }`}
                style={
                  dropAt?.index === i
                    ? {
                        boxShadow:
                          dropAt.pos === 'before'
                            ? `-2px 0 0 0 ${accentSolid()}`
                            : `2px 0 0 0 ${accentSolid()}`,
                      }
                    : undefined
                }
                draggable
                onDragStart={() => setDragIdx(i)}
                onDragEnd={clearDrag}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dragIdx === null || dragIdx === i) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const before = e.clientX - rect.left < rect.width / 2;
                  setDropAt({ index: i, pos: before ? 'before' : 'after' });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  onDrop(i);
                }}
              >
                <button
                  type="button"
                  className={`circle-chip ring-focus ${
                    playingIndex === i ? 'circle-chip-playing' : ''
                  }`}
                  onClick={() => previewChord(chord)}
                  onMouseEnter={() => setState({ hoveredChord: chord })}
                  onMouseLeave={() => setState({ hoveredChord: null })}
                >
                  <span className="text-meta t-tertiary">{pretty(romanNumeral(chord, key))}</span>
                  <span className="text-body t-primary whitespace-nowrap">
                    {pretty(chordName(chord))}
                  </span>
                </button>
                <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                  <IconButton title="Remove chord" onClick={() => removeAt(i)}>
                    <CloseIcon size={11} />
                  </IconButton>
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {!empty && (
        <p className="text-meta t-tertiary">
          ⌥-click a key on the circle to transpose the progression into it.
        </p>
      )}
    </section>
  );
};
