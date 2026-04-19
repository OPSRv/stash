import { describe, expect, it } from 'vitest';
import { bpmFromTaps } from './useTapTempo';

describe('bpmFromTaps', () => {
  it('returns null for fewer than 2 taps', () => {
    expect(bpmFromTaps([])).toBeNull();
    expect(bpmFromTaps([100])).toBeNull();
  });

  it('computes 120 BPM from taps spaced 500ms apart', () => {
    const taps = [0, 500, 1000, 1500];
    expect(bpmFromTaps(taps)).toBe(120);
  });

  it('clamps below the minimum BPM', () => {
    const taps = [0, 5000, 10_000];
    expect(bpmFromTaps(taps)).toBe(40);
  });

  it('clamps above the maximum BPM', () => {
    const taps = [0, 100, 200, 300];
    expect(bpmFromTaps(taps)).toBe(240);
  });
});
