import { describe, expect, it } from 'vitest';
import { trainerNextBpm } from './useTrainer';
import { DEFAULT_TRAINER, type TrainerConfig } from '../metronome.constants';

const cfg = (p: Partial<TrainerConfig> = {}): TrainerConfig => ({
  ...DEFAULT_TRAINER,
  enabled: true,
  step_bpm: 4,
  every_bars: 2,
  target_bpm: 160,
  ...p,
});

describe('trainerNextBpm', () => {
  it('returns null when disabled', () => {
    expect(trainerNextBpm({ barsCompleted: 4, currentBpm: 120, config: cfg({ enabled: false }) })).toBeNull();
  });

  it('returns null on bars that are not a multiple of every_bars', () => {
    expect(trainerNextBpm({ barsCompleted: 1, currentBpm: 120, config: cfg() })).toBeNull();
    expect(trainerNextBpm({ barsCompleted: 3, currentBpm: 120, config: cfg() })).toBeNull();
  });

  it('bumps BPM by step_bpm on every every_bars-th bar', () => {
    expect(trainerNextBpm({ barsCompleted: 2, currentBpm: 120, config: cfg() })).toBe(124);
    expect(trainerNextBpm({ barsCompleted: 4, currentBpm: 120, config: cfg() })).toBe(124);
  });

  it('clamps to target_bpm and then stops', () => {
    expect(trainerNextBpm({ barsCompleted: 2, currentBpm: 158, config: cfg({ target_bpm: 160 }) })).toBe(160);
    expect(trainerNextBpm({ barsCompleted: 4, currentBpm: 160, config: cfg({ target_bpm: 160 }) })).toBeNull();
  });

  it('never returns before any bar has completed', () => {
    expect(trainerNextBpm({ barsCompleted: 0, currentBpm: 120, config: cfg() })).toBeNull();
  });

  it('ignores zero every_bars to avoid divide-by-zero', () => {
    expect(trainerNextBpm({ barsCompleted: 4, currentBpm: 120, config: cfg({ every_bars: 0 }) })).toBeNull();
  });
});
