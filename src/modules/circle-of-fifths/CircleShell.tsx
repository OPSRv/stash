/* CircleShell — the embedded circle-of-fifths workspace hosted inside the
 * Valeton editor (the `Circle` toolbar button), the same arrangement as the
 * Metronome/Recorder shells: no tab of its own, the module stays standalone
 * under `src/modules/circle-of-fifths/`. See CLAUDE.md "Modularity".
 *
 * Layout: wheel on the left, key panel + fretboard on the right, progression
 * builder and AI panel across the bottom. Global ←/→/Enter shortcuts walk the
 * key selection without focusing the wheel; they pause while a field or any
 * control inside the shell has focus (those implement their own keys). */

import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { IconButton } from '../../shared/ui/IconButton';
import { SpeakerIcon } from '../../shared/ui/icons';
import { AiPanel } from './components/AiPanel';
import { CircleSvg } from './components/CircleSvg';
import { FretboardHint } from './components/FretboardHint';
import { KeyPanel } from './components/KeyPanel';
import { ProgressionBar } from './components/ProgressionBar';
import { applyExternalProgression, previewChord, transposeTo } from './lib/actions';
import { keyAt, pc, slotOfKey } from './lib/theory';
import { getState, seedTuningFromTuner, setState, useStore } from './store';
import './circle.css';

/** Walk the selection one circle slot in `dir`, rotating it to 12 o'clock —
 * the same semantics as the wheel's own arrow keys. */
const stepKey = (dir: 1 | -1): void => {
  const { key } = getState();
  const slot = pc(slotOfKey(key) + dir);
  setState({ key: keyAt(slot, key.minor), rotation: slot });
};

/** Quiet tonic-triad audition of the current key (gated on `soundOn`). */
const auditionKey = (): void => {
  const { key } = getState();
  previewChord({ root: key.tonic, quality: key.minor ? 'min' : 'maj' });
};

export const CircleShell = () => {
  const rootRef = useRef<HTMLDivElement>(null);
  const soundOn = useStore((s) => s.soundOn);

  // First mount: let the tuner's persisted tuning seed ours (no-op once a
  // tuning was picked or persisted here).
  useEffect(() => {
    void seedTuningFromTuner();
  }, []);

  // Assistant pushes (`circle_progression` LLM tool → Rust emit). The
  // listener lives for the shell's lifetime; pushes made before the Circle
  // view was first opened are dropped by design — the tool's reply tells
  // the user where to look.
  useEffect(() => {
    const un = listen<{ key?: string; chords?: string[]; bpm?: number }>(
      'circle:progression',
      (e) => applyExternalProgression(e.payload),
    );
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // Document-level shortcuts, active only while the shell is visible (the
  // Valeton shell stays mounted on other tabs). The inField guard mirrors
  // ValetonShell's; the contains() guard defers to focused inner widgets
  // (wheel, fretboard, chips) which handle their own arrows/Enter.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!rootRef.current || rootRef.current.offsetParent === null) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = (el?.tagName ?? '').toUpperCase();
      const inField =
        /^(INPUT|SELECT|TEXTAREA)$/.test(tag) || el?.isContentEditable === true;
      if (inField) return;
      if (el && el !== document.body && rootRef.current.contains(el)) return;
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault();
        stepKey(e.code === 'ArrowRight' ? 1 : -1);
      } else if (e.code === 'Enter') {
        e.preventDefault();
        auditionKey();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex min-h-0 flex-1 gap-4">
        <div className="relative flex min-w-0 flex-[5] items-stretch justify-center">
          <CircleSvg onAltSelect={transposeTo} />
          <span className="absolute right-0 top-0">
            <IconButton
              title={soundOn ? 'Sound on — click to mute previews' : 'Sound off — click to enable previews'}
              active={soundOn}
              onClick={() => setState({ soundOn: !getState().soundOn })}
            >
              <SpeakerIcon />
            </IconButton>
          </span>
        </div>
        {/* Right column scrolls if the fretboard runs past the popup height —
            bar hidden by the global scrollbar rules. */}
        <div className="flex min-w-0 flex-[4] flex-col gap-3 overflow-y-auto">
          <KeyPanel />
          <FretboardHint />
        </div>
      </div>
      <ProgressionBar />
      <AiPanel />
    </div>
  );
};
