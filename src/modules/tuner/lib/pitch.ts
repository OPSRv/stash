/* Monophonic pitch detection via the YIN algorithm (de Cheveigné & Kawahara,
 * 2002). YIN is the gold standard for single-note pitch tracking: it builds a
 * cumulative-mean-normalised *difference* function instead of a plain
 * autocorrelation, which is what makes it robust to the octave errors that
 * plague ACF peak-picking on a plucked string's strong overtones. A small
 * absolute threshold plus parabolic interpolation give it sub-cent precision —
 * the difference between "in tune" and "a few cents sharp".
 *
 * Kept as a pure function (buffer + sample rate → Hz) so it can be unit-tested
 * with synthetic sine waves, with no AudioContext in the loop. */

/** Below this RMS the buffer is treated as silence (no pitch present). */
const SILENCE_RMS = 0.01;

/** Lowest fundamental we bother searching for, in Hz. Comfortably below a
 *  Drop-A / 7-string low string, so the period (and thus the τ search) stays
 *  bounded — searching arbitrarily low invites sub-harmonic lock-ons. */
const MIN_FREQ = 35;

/** Highest fundamental we search for, in Hz — well above the top open string;
 *  raising the floor on τ keeps the threshold pass off the noise floor. */
const MAX_FREQ = 1400;

/** YIN absolute threshold. The first dip in the normalised difference function
 *  below this is taken as the period; 0.1–0.15 is the canonical range. Lower is
 *  stricter (fewer false positives, may miss a weak note); 0.15 tracks a
 *  decaying pluck well. */
const YIN_THRESHOLD = 0.15;

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

  // Bound the lag search to the plausible guitar range. τ (the period in
  // samples) runs from sampleRate/MAX_FREQ up to sampleRate/MIN_FREQ; the
  // integration window W gets whatever buffer is left so the longest period
  // still fits inside it.
  const tauMin = Math.max(2, Math.floor(sampleRate / MAX_FREQ));
  const tauMax = Math.min(Math.floor(sampleRate / MIN_FREQ), size >> 1);
  if (tauMax <= tauMin) return -1;
  const W = size - tauMax; // samples averaged per lag (i + τ never exceeds size)

  // Difference function d(τ) = Σ (x[i] − x[i+τ])²  — zero when the window lines
  // up with a copy of itself one period later.
  const diff = new Float32Array(tauMax);
  for (let tau = tauMin; tau < tauMax; tau++) {
    let sum = 0;
    for (let i = 0; i < W; i++) {
      const delta = buffer[i] - buffer[i + tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
  }

  // Cumulative mean normalisation: d'(τ) = d(τ) · τ / Σ_{j≤τ} d(j). This
  // de-emphasises τ=0 (always a perfect match) and the dips at the period's
  // multiples, so the *first* deep dip is the true fundamental — the step that
  // kills octave errors.
  const cmnd = new Float32Array(tauMax);
  let runningSum = 0;
  cmnd[tauMin - 1] = 1;
  for (let tau = tauMin; tau < tauMax; tau++) {
    runningSum += diff[tau];
    cmnd[tau] = runningSum > 0 ? (diff[tau] * (tau - tauMin + 1)) / runningSum : 1;
  }

  // Absolute threshold: take the first τ whose normalised difference dips below
  // YIN_THRESHOLD, then descend to the local minimum of that dip.
  let tau = -1;
  for (let t = tauMin; t < tauMax; t++) {
    if (cmnd[t] < YIN_THRESHOLD) {
      while (t + 1 < tauMax && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }
  // Nothing crossed the threshold — the signal is aperiodic (noise, a chord,
  // string buzz). Report no pitch rather than guess at a spurious peak.
  if (tau === -1) return -1;

  // Parabolic interpolation around the dip for sub-sample period precision.
  const x0 = tau > tauMin ? cmnd[tau - 1] : cmnd[tau];
  const x2 = tau + 1 < tauMax ? cmnd[tau + 1] : cmnd[tau];
  const a = x0 + x2 - 2 * cmnd[tau];
  const b = (x2 - x0) / 2;
  const period = a !== 0 ? tau - b / a : tau;
  if (period <= 0) return -1;

  return sampleRate / period;
};
