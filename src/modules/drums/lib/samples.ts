/* Sampled drum kits (recorded one-shots, CC0 — see samples/README.md).
 *
 * Files are 44.1 kHz mono WAVs peak-normalised to -1 dBFS by
 * scripts/build-drum-samples.py; this module restores a natural balance
 * (VOICE_LEVEL) and dynamics (hit vs accent) at playback.
 *
 * Loading is lazy and per kit: the URLs are resolved at build time, but a
 * kit's bytes are fetched only when that kit is first used (perf elephant —
 * nothing on the popup-open path). Raw bytes are cached once; decoded
 * buffers are cached per AudioContext, because the offline export renders
 * on its own context. */

import { VOICES, type DrumKit, type DrumVoice } from './model';
import type { VoiceHandle } from './voices';

export type SampledKit = Exclude<DrumKit, 'electronic'>;

export const isSampledKit = (k: DrumKit): k is SampledKit => k !== 'electronic';

// Vite resolves these to hashed asset URLs; no bytes load until fetched.
const URLS = import.meta.glob('../samples/*/*.wav', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const urlFor = (kit: SampledKit, file: string): string | undefined => URLS[`../samples/${kit}/${file}.wav`];

/** Kit balance after per-file peak normalisation (cymbals and hats sit
 *  under the kick/snare like a real mix). */
const VOICE_LEVEL: Record<DrumVoice, number> = {
  kick: 1,
  snare: 0.85,
  chh: 0.42,
  ohh: 0.45,
  clap: 0.6,
  tom: 0.75,
  rim: 0.55,
  crash: 0.42,
};

/** Gain of a plain hit relative to an accent. A voice with its own accent
 *  layer gets a timbre change too; one without just plays quieter. */
const HIT_LEVEL = 0.6;

export type KitBuffers = Record<DrumVoice, { hit: AudioBuffer; accent: AudioBuffer | null }>;

const bytesCache = new Map<string, Promise<ArrayBuffer>>();
const decodedCache = new WeakMap<BaseAudioContext, Map<SampledKit, Promise<KitBuffers>>>();

const fetchBytes = (url: string): Promise<ArrayBuffer> => {
  let p = bytesCache.get(url);
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`drum sample ${url}: HTTP ${r.status}`);
      return r.arrayBuffer();
    });
    // A failed fetch must be retryable, not cached forever.
    p.catch(() => bytesCache.delete(url));
    bytesCache.set(url, p);
  }
  return p;
};

// decodeAudioData detaches its input on some engines — always hand it a copy.
const decode = async (ctx: BaseAudioContext, url: string): Promise<AudioBuffer> =>
  ctx.decodeAudioData((await fetchBytes(url)).slice(0));

/** Warm the byte cache for `kit` without an AudioContext (Drums view
 *  opened / kit switched) so the first Play only has to decode. */
export const prefetchKit = (kit: SampledKit): void => {
  for (const v of VOICES) {
    for (const f of [v, `${v}-accent`]) {
      const url = urlFor(kit, f);
      if (url) fetchBytes(url).catch(() => {});
    }
  }
};

/** Decoded buffers of `kit` for `ctx` (fetched + decoded once per context). */
export const loadKit = (ctx: BaseAudioContext, kit: SampledKit): Promise<KitBuffers> => {
  let perCtx = decodedCache.get(ctx);
  if (!perCtx) {
    perCtx = new Map();
    decodedCache.set(ctx, perCtx);
  }
  let p = perCtx.get(kit);
  if (!p) {
    p = Promise.all(
      VOICES.map(async (v) => {
        const hitUrl = urlFor(kit, v);
        if (!hitUrl) throw new Error(`drum kit ${kit}: missing ${v}.wav`);
        const accentUrl = urlFor(kit, `${v}-accent`);
        const [hit, accent] = await Promise.all([
          decode(ctx, hitUrl),
          accentUrl ? decode(ctx, accentUrl) : Promise.resolve(null),
        ]);
        return [v, { hit, accent }] as const;
      }),
    ).then((entries) => Object.fromEntries(entries) as KitBuffers);
    p.catch(() => perCtx!.delete(kit));
    perCtx.set(kit, p);
  }
  return p;
};

/** Slight per-hit level wobble so repeated samples don't sound like a
 *  machine-gun (real drummers never hit twice the same). ±4%. */
const humanize = () => 0.96 + Math.random() * 0.08;

/** Play one sampled hit. `accent` picks the hard layer when present. */
export const playSample = (
  ctx: BaseAudioContext,
  out: AudioNode,
  kit: KitBuffers,
  voice: DrumVoice,
  t: number,
  accent: boolean,
): VoiceHandle => {
  const layers = kit[voice];
  const buffer = accent && layers.accent ? layers.accent : layers.hit;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const g = ctx.createGain();
  g.gain.value = VOICE_LEVEL[voice] * (accent ? 1 : HIT_LEVEL) * humanize();
  src.connect(g).connect(out);
  src.start(t);
  return {
    choke: (at: number) => {
      if (at <= t || at >= t + buffer.duration) return;
      g.gain.cancelScheduledValues(at);
      g.gain.setTargetAtTime(0, at, 0.012);
    },
  };
};
