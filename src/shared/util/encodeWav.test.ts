import { describe, expect, it, vi } from 'vitest';
import { blobToWav16Mono } from './encodeWav';

/** Minimal AudioBuffer / AudioContext fakes. JSDOM has no Web Audio,
 *  so we install just enough to exercise the encode path: `decodeAudioData`
 *  yields a deterministic synthetic buffer; the rest is pure JS. */
class FakeAudioBuffer {
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  readonly length: number;
  private data: Float32Array[];
  constructor(channels: Float32Array[], sampleRate: number) {
    this.data = channels;
    this.numberOfChannels = channels.length;
    this.sampleRate = sampleRate;
    this.length = channels[0].length;
  }
  getChannelData(i: number): Float32Array {
    return this.data[i];
  }
}

const installAudioCtx = (buffer: FakeAudioBuffer) => {
  // `new Ctx()` in production code requires a constructable function —
  // arrow functions aren't. A regular `function` works, as does a
  // class. Using a class keeps the intent obvious.
  class FakeCtx {
    decodeAudioData = vi.fn(async () => buffer);
    close = vi.fn(async () => {});
  }
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeCtx;
  return FakeCtx;
};

describe('blobToWav16Mono', () => {
  it('produces a well-formed RIFF/WAVE header at 16 kHz mono s16le', async () => {
    // 1 second of silence at 48 kHz stereo → ~32000 bytes of PCM after
    // downmix + resample to 16 kHz mono.
    const ch = new Float32Array(48_000);
    const buffer = new FakeAudioBuffer([ch, ch], 48_000);
    installAudioCtx(buffer);

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' });
    const wav = await blobToWav16Mono(blob);

    // Header bytes identify the RIFF container + format.
    const ascii = (slice: Uint8Array) =>
      Array.from(slice, (b) => String.fromCharCode(b)).join('');
    expect(ascii(wav.slice(0, 4))).toBe('RIFF');
    expect(ascii(wav.slice(8, 12))).toBe('WAVE');
    expect(ascii(wav.slice(12, 16))).toBe('fmt ');
    expect(ascii(wav.slice(36, 40))).toBe('data');

    const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(dv.getUint16(20, true)).toBe(1); // PCM
    expect(dv.getUint16(22, true)).toBe(1); // mono
    expect(dv.getUint32(24, true)).toBe(16_000); // resampled rate
    expect(dv.getUint16(34, true)).toBe(16); // bits per sample

    // Exactly one second of mono 16 kHz s16le → 32000 bytes of data.
    expect(dv.getUint32(40, true)).toBe(32_000);
    expect(wav.byteLength).toBe(44 + 32_000);
  });

  it('mixes stereo to mono by averaging both channels', async () => {
    // Two channels with constant opposite polarity → mono average is 0
    // → s16le sample 0, regardless of sample rate.
    const L = new Float32Array([1, 1, 1, 1]);
    const R = new Float32Array([-1, -1, -1, -1]);
    installAudioCtx(new FakeAudioBuffer([L, R], 16_000));

    const wav = await blobToWav16Mono(new Blob([new Uint8Array([0])]));
    const pcm = new Int16Array(wav.buffer, 44);
    for (const sample of pcm) expect(sample).toBe(0);
  });
});
