/* Drum voices synthesised with plain Web Audio nodes — no samples, so the
 * bundle stays tiny. Every voice is a pure function of (context, output,
 * time, velocity), which is what lets the live engine and the offline WAV
 * render share one code path and sound identical.
 *
 * Recipes follow the classic analogue drum-machine designs: pitched sine
 * sweeps for kick/tom, filtered noise for snare/clap, six detuned square
 * oscillators through band-pass filters for the metallic hats/cymbal.
 * Tuned by ear. */

import type { DrumVoice } from './model';

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

/** One second of white noise per context, reused by every noise voice. */
const noiseBuffer = (ctx: BaseAudioContext): AudioBuffer => {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, buf);
  }
  return buf;
};

const noise = (ctx: BaseAudioContext, t: number, dur: number): AudioBufferSourceNode => {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.start(t);
  src.stop(t + dur);
  return src;
};

/** Gain node with a fast attack and exponential decay to silence. */
const envelope = (ctx: BaseAudioContext, t: number, peak: number, decay: number): GainNode => {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  return g;
};

const filter = (
  ctx: BaseAudioContext,
  type: BiquadFilterType,
  freq: number,
  q = 0.7,
): BiquadFilterNode => {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
};

const METAL_RATIOS = [2, 3, 4.16, 5.43, 6.79, 8.21];

/** Six inharmonic squares — the metallic core of hats and cymbals. */
const metal = (ctx: BaseAudioContext, t: number, dur: number, out: AudioNode): void => {
  for (const r of METAL_RATIOS) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = 40 * r;
    o.connect(out);
    o.start(t);
    o.stop(t + dur);
  }
};

/** Handle for voices that can be cut short (open hat choked by a closed
 *  hat, like a real hi-hat pedal). */
export type VoiceHandle = { choke: (at: number) => void };

const NOOP: VoiceHandle = { choke: () => {} };

/** Trigger `voice` at absolute context time `t` into `out`. `velocity` is
 *  the linear peak (accent ≈ 1, normal hit ≈ 0.7). */
export const playVoice = (
  ctx: BaseAudioContext,
  out: AudioNode,
  voice: DrumVoice,
  t: number,
  velocity: number,
): VoiceHandle => {
  const v = velocity;
  switch (voice) {
    case 'kick': {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      const g = envelope(ctx, t, v, 0.45);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + 0.5);
      // Beater click on top of the body.
      const c = noise(ctx, t, 0.01);
      c.connect(filter(ctx, 'highpass', 3000)).connect(envelope(ctx, t, v * 0.35, 0.008)).connect(out);
      return NOOP;
    }
    case 'snare': {
      const n = noise(ctx, t, 0.25);
      n.connect(filter(ctx, 'highpass', 1200)).connect(envelope(ctx, t, v * 0.7, 0.2)).connect(out);
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(220, t);
      o.frequency.exponentialRampToValueAtTime(170, t + 0.08);
      o.connect(envelope(ctx, t, v * 0.6, 0.1)).connect(out);
      o.start(t);
      o.stop(t + 0.15);
      return NOOP;
    }
    case 'chh':
    case 'ohh': {
      const decay = voice === 'chh' ? 0.06 : 0.4;
      const g = envelope(ctx, t, v * 0.32, decay);
      const bp = filter(ctx, 'bandpass', 10000, 0.8);
      bp.connect(filter(ctx, 'highpass', 7000)).connect(g).connect(out);
      metal(ctx, t, decay + 0.05, bp);
      return {
        choke: (at: number) => {
          if (at <= t || at >= t + decay) return;
          g.gain.cancelScheduledValues(at);
          g.gain.setTargetAtTime(0, at, 0.008);
        },
      };
    }
    case 'clap': {
      const bp = filter(ctx, 'bandpass', 1200, 1.2);
      bp.connect(out);
      // Three fast bursts then a short tail — the "many hands" smear.
      for (const [dt, peak, decay] of [
        [0, 0.8, 0.012],
        [0.011, 0.7, 0.012],
        [0.022, 0.75, 0.15],
      ] as const) {
        noise(ctx, t + dt, decay + 0.02).connect(envelope(ctx, t + dt, v * peak, decay)).connect(bp);
      }
      return NOOP;
    }
    case 'tom': {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(190, t);
      o.frequency.exponentialRampToValueAtTime(95, t + 0.25);
      o.connect(envelope(ctx, t, v * 0.9, 0.38)).connect(out);
      o.start(t);
      o.stop(t + 0.42);
      return NOOP;
    }
    case 'rim': {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = 1700;
      o.connect(envelope(ctx, t, v * 0.5, 0.03)).connect(out);
      o.start(t);
      o.stop(t + 0.05);
      noise(ctx, t, 0.02)
        .connect(filter(ctx, 'highpass', 4000))
        .connect(envelope(ctx, t, v * 0.3, 0.015))
        .connect(out);
      return NOOP;
    }
    case 'crash': {
      const g = envelope(ctx, t, v * 0.28, 1.6);
      const hp = filter(ctx, 'highpass', 4500);
      hp.connect(g).connect(out);
      const bp = filter(ctx, 'bandpass', 7000, 0.5);
      bp.connect(hp);
      metal(ctx, t, 1.7, bp);
      noise(ctx, t, 1.7).connect(envelope(ctx, t, v * 0.25, 1.4)).connect(hp);
      return NOOP;
    }
  }
};

/** Longest voice tail in seconds (the sampled crash is cut at 2.5 s) — the
 *  offline render pads by this much before folding tails back onto the
 *  loop start. */
export const MAX_TAIL_S = 2.6;

/** Linear peak for a step value (1 = hit, 2 = accent). */
export const velocityFor = (step: 1 | 2): number => (step === 2 ? 1 : 0.7);
