/* Tiny Web Audio synth for chord/scale playback. No React, no Tauri.
 *
 * Each note is a triangle oscillator plus a sine one octave down (0.35× gain)
 * through a shared ADSR gain envelope; everything feeds one master
 * DynamicsCompressorNode so strummed chords don't clip. The AudioContext is
 * created lazily on the first play call — never at module load (keeps the
 * popup-open path free) — and reused afterwards.
 *
 * Validated by ear, not by tests: envelope and scheduling are exactly the
 * kind of thing unit tests can't hear. */

import type { Chord } from './theory';
import { chordPitches } from './theory';
import { midiToFreq } from '../../../shared/music/tunings';

let ctx: AudioContext | null = null;
let master: DynamicsCompressorNode | null = null;

const ensureCtx = (): AudioContext => {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createDynamicsCompressor();
    master.connect(ctx.destination);
  }
  // WKWebView may start (or auto-suspend) the context in 'suspended' state.
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
};

/* ADSR time constants for setTargetAtTime, plus sustain level fraction. */
const ATTACK = 0.01;
const DECAY = 0.15;
const SUSTAIN = 0.5;
const RELEASE = 0.3;

export type NoteOptions = {
  /** Absolute AudioContext time to start at; defaults to "now". */
  at?: number;
  /** Sustained duration in seconds before the release begins. */
  dur?: number;
  /** Peak envelope gain. */
  gain?: number;
};

export function playNote(midi: number, { at, dur = 0.9, gain = 0.18 }: NoteOptions = {}): void {
  const audio = ensureCtx();
  const start = at ?? audio.currentTime;
  const freq = midiToFreq(midi);

  const env = audio.createGain();
  env.gain.value = 0;
  env.connect(master!);

  const osc = audio.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  osc.connect(env);

  const subGain = audio.createGain();
  subGain.gain.value = 0.35;
  subGain.connect(env);
  const sub = audio.createOscillator();
  sub.type = 'sine';
  sub.frequency.value = freq / 2; // one octave down fattens the tone
  sub.connect(subGain);

  // ADSR: attack to peak, decay to sustain, exponential-ish release after dur.
  env.gain.setValueAtTime(0, start);
  env.gain.setTargetAtTime(gain, start, ATTACK);
  env.gain.setTargetAtTime(gain * SUSTAIN, start + ATTACK, DECAY);
  env.gain.setTargetAtTime(0, start + dur, RELEASE);

  // Let the release tail fade (~4 time constants), then free the nodes.
  const end = start + dur + RELEASE * 4;
  osc.start(start);
  sub.start(start);
  osc.stop(end);
  sub.stop(end);
  osc.onended = () => {
    osc.disconnect();
    sub.disconnect();
    subGain.disconnect();
    env.disconnect();
  };
}

export type ChordOptions = NoteOptions & {
  /** Per-note onset offset in seconds, light guitar-style strum. */
  strum?: number;
};

export function playChord(midis: number[], { strum = 0.03, ...note }: ChordOptions = {}): void {
  const at = note.at ?? ensureCtx().currentTime;
  midis.forEach((midi, i) => playNote(midi, { ...note, at: at + i * strum }));
}

/** Play the notes as straight eighth notes at the given tempo. */
export function playArpeggio(midis: number[], bpm: number): void {
  const audio = ensureCtx();
  const step = 30 / bpm; // an eighth note is half a beat
  const at = audio.currentTime;
  midis.forEach((midi, i) => playNote(midi, { at: at + i * step, dur: step * 0.9 }));
}

/** Root-position voicing around octave 4: the root lands in C4–B4 and the
 * remaining chord tones stack upward from it. */
export const chordMidis = (chord: Chord): number[] => {
  const pcs = chordPitches(chord);
  const root = 60 + pcs[0];
  return pcs.map((p) => root + (((p - pcs[0]) % 12) + 12) % 12);
};

/* Future audio is scheduled lazily, one setTimeout per bar computed against
 * ctx.currentTime: each timer fires slightly early and schedules its chord at
 * the exact AudioContext time (sample-accurate, no drift), so stop() can
 * cancel everything that hasn't sounded yet. */
const LOOKAHEAD = 0.05;

export function playProgression(
  chords: Chord[],
  bpm: number,
  onStep: (index: number | null) => void,
): { stop: () => void } {
  const audio = ensureCtx();
  const barSec = (60 / bpm) * 4; // one chord per bar, four beats
  const t0 = audio.currentTime + 0.08;
  const timers: ReturnType<typeof setTimeout>[] = [];

  chords.forEach((chord, i) => {
    const at = t0 + i * barSec;
    const delayMs = Math.max(0, (at - LOOKAHEAD - audio.currentTime) * 1000);
    timers.push(
      setTimeout(() => {
        playChord(chordMidis(chord), { at, dur: barSec * 0.9 });
        onStep(i);
      }, delayMs),
    );
  });

  const endMs = Math.max(0, (t0 + chords.length * barSec - audio.currentTime) * 1000);
  timers.push(setTimeout(() => onStep(null), endMs));

  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      for (const t of timers) clearTimeout(t);
      onStep(null);
    },
  };
}
