import { describe, expect, it } from 'vitest';
import { tickInterval } from './useMetronomeEngine';

describe('tickInterval', () => {
  it('returns 0.5s at 120 BPM with no subdivision', () => {
    expect(tickInterval(120, 1)).toBeCloseTo(0.5, 5);
  });

  it('halves with eighth-note subdivision', () => {
    expect(tickInterval(120, 2)).toBeCloseTo(0.25, 5);
  });

  it('scales linearly with BPM', () => {
    expect(tickInterval(60, 1)).toBeCloseTo(1, 5);
    expect(tickInterval(240, 1)).toBeCloseTo(0.25, 5);
  });
});
