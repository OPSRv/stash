/* Monophonic pitch detection via normalized autocorrelation (the "ACF2+"
 * approach popularised by Chris Wilson's PitchDetect). It is cheap enough to
 * run every animation frame on a guitar signal and robust to the strong
 * harmonics a plucked string produces — far more reliable than picking the
 * loudest FFT bin, which routinely locks onto an overtone.
 *
 * Kept as a pure function (buffer + sample rate → Hz) so it can be unit-tested
 * with synthetic sine waves, with no AudioContext in the loop. */

/** Below this RMS the buffer is treated as silence (no pitch present). */
const SILENCE_RMS = 0.01;

/**
 * Estimate the fundamental frequency of `buffer` (time-domain samples in
 * [-1, 1]) sampled at `sampleRate` Hz.
 *
 * @returns frequency in Hz, or -1 when the signal is too quiet / aperiodic.
 */
export const detectPitch = (buffer: Float32Array, sampleRate: number): number => {
  const size = buffer.length;

  // Gate on loudness — a quiet buffer is silence between notes, not a pitch.
  let sumSquares = 0;
  for (let i = 0; i < size; i++) sumSquares += buffer[i] * buffer[i];
  const rms = Math.sqrt(sumSquares / size);
  if (rms < SILENCE_RMS) return -1;

  // Trim leading/trailing samples below 20% of peak so the window holds the
  // sustained, periodic part of the pluck rather than the attack transient.
  const threshold = 0.2;
  let start = 0;
  let end = size - 1;
  while (start < size / 2 && Math.abs(buffer[start]) < threshold) start++;
  while (end > size / 2 && Math.abs(buffer[end]) < threshold) end--;

  const trimmed = buffer.subarray(start, end);
  const n = trimmed.length;
  if (n < 2) return -1;

  // Autocorrelation: correlation of the signal with a lag-shifted copy.
  const corr = new Float32Array(n);
  for (let lag = 0; lag < n; lag++) {
    let sum = 0;
    for (let i = 0; i < n - lag; i++) sum += trimmed[i] * trimmed[i + lag];
    corr[lag] = sum;
  }

  // Walk past the zero-lag peak to the first rising edge, then find the
  // highest peak after it — that lag is the fundamental period.
  let d = 0;
  while (d < n - 1 && corr[d] > corr[d + 1]) d++;

  let maxPos = -1;
  let maxVal = -Infinity;
  for (let lag = d; lag < n; lag++) {
    if (corr[lag] > maxVal) {
      maxVal = corr[lag];
      maxPos = lag;
    }
  }
  if (maxPos <= 0) return -1;

  // Parabolic interpolation around the peak for sub-sample period precision
  // (the difference between "in tune" and "a few cents sharp").
  const y0 = corr[maxPos - 1] ?? corr[maxPos];
  const y1 = corr[maxPos];
  const y2 = corr[maxPos + 1] ?? corr[maxPos];
  const denom = 2 * (2 * y1 - y0 - y2);
  const shift = denom !== 0 ? (y2 - y0) / denom : 0;
  const period = maxPos + shift;
  if (period <= 0) return -1;

  return sampleRate / period;
};
