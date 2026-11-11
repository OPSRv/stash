/* The drum bus shared by live playback and the offline export:
 * voice → per-voice gain → master gain → compressor (glue + clip guard) →
 * destination. Plus `triggerStep`, the one place that turns a grid column
 * into sound, so live and exported loops can't drift apart. */

import { type DrumsState, type DrumVoice, VOICES } from './model';
import { playSample, type KitBuffers } from './samples';
import { playVoice, velocityFor, type VoiceHandle } from './voices';

export type DrumMixer = {
  voiceOut: Record<DrumVoice, GainNode>;
  /** Push volume / mute / master changes into the live gains. */
  apply: (s: DrumsState) => void;
  disconnect: () => void;
};

export const createMixer = (ctx: BaseAudioContext, dest: AudioNode, s: DrumsState): DrumMixer => {
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -10;
  comp.knee.value = 6;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.12;
  const master = ctx.createGain();
  master.connect(comp).connect(dest);
  const voiceOut = Object.fromEntries(
    VOICES.map((v) => {
      const g = ctx.createGain();
      g.connect(master);
      return [v, g];
    }),
  ) as Record<DrumVoice, GainNode>;
  const apply = (st: DrumsState) => {
    master.gain.value = st.master_volume;
    for (const v of VOICES) voiceOut[v].gain.value = st.mix[v].muted ? 0 : st.mix[v].volume;
  };
  apply(s);
  return {
    voiceOut,
    apply,
    disconnect: () => {
      for (const v of VOICES) voiceOut[v].disconnect();
      master.disconnect();
      comp.disconnect();
    },
  };
};

/** Per-render scratch: the ringing open hat so a closed hat can choke it. */
export type ChokeState = { openHat: VoiceHandle | null };

/** Fire one voice: a recorded sample when `kit` buffers are given, the
 *  synth otherwise (Electronic kit). */
export const hitVoice = (
  ctx: BaseAudioContext,
  out: AudioNode,
  kit: KitBuffers | null,
  voice: DrumVoice,
  t: number,
  step: 1 | 2,
): VoiceHandle =>
  kit ? playSample(ctx, out, kit, voice, t, step === 2) : playVoice(ctx, out, voice, t, velocityFor(step));

/** Fire every active voice of pattern column `col` at time `t`. Muted voices
 *  are skipped outright (no wasted nodes). */
export const triggerStep = (
  ctx: BaseAudioContext,
  mixer: DrumMixer,
  s: DrumsState,
  col: number,
  t: number,
  choke: ChokeState,
  kit: KitBuffers | null,
): void => {
  for (const v of VOICES) {
    const step = s.steps[v][col];
    if (!step || s.mix[v].muted) continue;
    if (v === 'chh') choke.openHat?.choke(t);
    const h = hitVoice(ctx, mixer.voiceOut[v], kit, v, t, step as 1 | 2);
    if (v === 'ohh') choke.openHat = h;
  }
};
