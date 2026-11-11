import { useCallback, useRef } from 'react';
import { BPM_MAX, BPM_MIN } from '../metronome.constants';

const WINDOW_SIZE = 4;
/** Reset the buffer if no tap arrives within this many ms — a stale gap
 *  would otherwise pull the average toward absurdly low BPMs. */
const RESET_AFTER_MS = 2000;

/** Compute BPM from the rolling buffer of the last few tap timestamps. */
export const bpmFromTaps = (taps: number[]): number | null => {
  if (taps.length < 2) return null;
  const intervals: number[] = [];
  for (let i = 1; i < taps.length; i++) intervals.push(taps[i] - taps[i - 1]);
  const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  if (avg <= 0) return null;
  const bpm = Math.round(60_000 / avg);
  return Math.min(BPM_MAX, Math.max(BPM_MIN, bpm));
};

export const useTapTempo = (onBpm: (bpm: number) => void) => {
  const tapsRef = useRef<number[]>([]);

  return useCallback(() => {
    const now = performance.now();
    const last = tapsRef.current[tapsRef.current.length - 1];
    if (last !== undefined && now - last > RESET_AFTER_MS) {
      tapsRef.current = [];
    }
    tapsRef.current.push(now);
    if (tapsRef.current.length > WINDOW_SIZE) tapsRef.current.shift();
    const bpm = bpmFromTaps(tapsRef.current);
    if (bpm !== null) onBpm(bpm);
  }, [onBpm]);
};
