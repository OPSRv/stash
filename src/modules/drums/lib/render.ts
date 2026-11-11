/* Offline loop render → seamless stereo WAV.
 *
 * Renders `bars` bars plus a tail pad, then folds the tail (crash ring-out,
 * open hats, kick decay spilling past the last bar) back onto the start —
 * exactly what you hear when the loop wraps, so the file repeats in a DAW
 * or looper without a click or a gap. */

import { encodeWavPcm16 } from '../../../shared/util/encodeWav';
import { METER_GRID, patternLength, stepDuration, stepOffset, type DrumsState } from './model';
import { createMixer, triggerStep, type ChokeState } from './mixer';
import { isSampledKit, loadKit } from './samples';
import { MAX_TAIL_S } from './voices';

const SAMPLE_RATE = 44_100;
const PEAK_CEILING = 0.98;

/** Loop length in seconds for `bars` bars at the state's tempo. */
export const loopSeconds = (s: DrumsState, bars: number): number =>
  METER_GRID[s.meter].stepsPerBar * bars * stepDuration(s.bpm, s.meter);

/** Fold `tail` frames past `loopFrames` onto the beginning, in place.
 *  Exported for tests. */
export const foldTail = (data: Float32Array, loopFrames: number): Float32Array => {
  for (let i = loopFrames; i < data.length; i++) data[(i - loopFrames) % loopFrames] += data[i];
  return data.subarray(0, loopFrames);
};

export const renderLoopWav = async (s: DrumsState, bars: number): Promise<Uint8Array> => {
  const loopS = loopSeconds(s, bars);
  const loopFrames = Math.round(loopS * SAMPLE_RATE);
  const total = loopFrames + Math.ceil(MAX_TAIL_S * SAMPLE_RATE);
  const Ctor =
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  const ctx = new Ctor(2, total, SAMPLE_RATE);
  const mixer = createMixer(ctx, ctx.destination, s);
  // Samples decode per context — the offline one needs its own copy.
  const kit = isSampledKit(s.kit) ? await loadKit(ctx, s.kit) : null;
  const choke: ChokeState = { openHat: null };
  const len = patternLength(s);
  const totalSteps = METER_GRID[s.meter].stepsPerBar * bars;
  const loopDur = len * stepDuration(s.bpm, s.meter);
  for (let i = 0; i < totalSteps; i++) {
    const col = i % len;
    const t = Math.floor(i / len) * loopDur + stepOffset(col, s.bpm, s.meter, s.swing);
    triggerStep(ctx, mixer, s, col, t, choke, kit);
  }
  const rendered = await ctx.startRendering();

  const channels = [0, 1].map((c) => foldTail(rendered.getChannelData(c), loopFrames));
  // Clip guard: the compressor tames peaks but a dense pattern + accents
  // can still poke over full scale once tails are folded in.
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  if (peak > PEAK_CEILING) {
    const k = PEAK_CEILING / peak;
    for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= k;
  }
  return encodeWavPcm16(channels, SAMPLE_RATE);
};
