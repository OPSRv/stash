/**
 * Convert an arbitrary audio blob (webm/opus, mp4/aac, ogg, …) into a
 * 16 kHz mono 16-bit PCM WAV `Uint8Array` that Whisper can decode
 * directly. Done in-browser because symphonia's Rust-side pipeline
 * can't decode Opus inside a WebM container — it demuxes fine but has
 * no Opus codec decoder wired up for Matroska. Encoding WAV here also
 * shrinks the payload on the IPC hop (~32 kB/s vs ~10–20 kB/s Opus,
 * but eliminates the server-side decode failure path entirely).
 *
 * The pipeline:
 *   1. `AudioContext.decodeAudioData` — the browser already knows how
 *      to decode whatever it just encoded, regardless of codec.
 *   2. Mix to mono (average channels).
 *   3. Linear resample to 16 kHz.
 *   4. Clip + quantise to s16le, write a 44-byte WAV header.
 */

const TARGET_HZ = 16_000;

export async function blobToWav16Mono(blob: Blob): Promise<Uint8Array> {
  const arrayBuf = await blob.arrayBuffer();
  // `webkitAudioContext` is still the only offline-capable ctor on
  // older Safari — Stash runs in Tauri's WebKit webview on macOS, so
  // we keep the fallback rather than assuming the standard name.
  const Ctx =
    (globalThis as unknown as { AudioContext?: typeof AudioContext })
      .AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctx) throw new Error('AudioContext не доступний у цьому середовищі.');
  const ctx = new Ctx();
  let decoded: AudioBuffer;
  try {
    // `decodeAudioData` transfers ownership of the buffer on some
    // engines — clone first so the caller's Blob remains reusable.
    decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
  } finally {
    // `close` is optional on every browser but frees the audio thread
    // on Safari immediately instead of waiting for GC.
    if (typeof ctx.close === 'function') ctx.close().catch(() => {});
  }
  const mono = mixToMono(decoded);
  const resampled = linearResample(mono, decoded.sampleRate, TARGET_HZ);
  return encodeWavMono16(resampled, TARGET_HZ);
}

function mixToMono(buf: AudioBuffer): Float32Array {
  if (buf.numberOfChannels === 1) return buf.getChannelData(0);
  const out = new Float32Array(buf.length);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < buf.length; i++) out[i] += data[i];
  }
  const inv = 1 / buf.numberOfChannels;
  for (let i = 0; i < buf.length; i++) out[i] *= inv;
  return out;
}

function linearResample(input: Float32Array, fromHz: number, toHz: number): Float32Array {
  if (fromHz === toHz) return input;
  const ratio = fromHz / toHz;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const lo = Math.floor(src);
    const hi = Math.min(lo + 1, input.length - 1);
    const t = src - lo;
    out[i] = input[lo] * (1 - t) + input[hi] * t;
  }
  return out;
}

function encodeWavMono16(samples: Float32Array, sampleRate: number): Uint8Array {
  const byteRate = sampleRate * 2;
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  // RIFF header — 44 bytes, canonical PCM mono s16le.
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    // Math.max/min faster than Math.round + clamp in hot loops; this
    // runs once per utterance so either is fine, but the branchless
    // form reads cleanly.
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}
