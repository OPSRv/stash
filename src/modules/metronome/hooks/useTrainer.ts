import { useEffect, useRef } from 'react';
import type { TrainerConfig } from '../metronome.constants';

type EngineLike = {
  isPlaying: boolean;
  onBeat: (cb: (beatDot: number, isAccent: boolean) => void) => () => void;
};

export type TrainerInput = {
  barsCompleted: number;
  currentBpm: number;
  config: TrainerConfig;
};

/** Pure: given how many bars have completed, should we bump the BPM?
 *  Returns the next BPM, or null if nothing should change. */
export const trainerNextBpm = ({ barsCompleted, currentBpm, config }: TrainerInput): number | null => {
  if (!config.enabled) return null;
  if (barsCompleted <= 0) return null;
  if (config.every_bars <= 0) return null;
  if (barsCompleted % config.every_bars !== 0) return null;
  if (currentBpm >= config.target_bpm) return null;
  return Math.min(config.target_bpm, currentBpm + config.step_bpm);
};

type UseTrainerArgs = {
  engine: EngineLike;
  bpm: number;
  config: TrainerConfig;
  onBpmChange: (bpm: number) => void;
};

/** Drives the trainer: counts completed bars of play and calls `onBpmChange`
 *  whenever `trainerNextBpm` says to. Resets the bar counter on play start
 *  and whenever trainer is toggled on. */
export const useTrainer = ({ engine, bpm, config, onBpmChange }: UseTrainerArgs) => {
  const barsRef = useRef(0);
  const firstBeatRef = useRef(true);
  const bpmRef = useRef(bpm);
  const cfgRef = useRef(config);
  const cbRef = useRef(onBpmChange);

  bpmRef.current = bpm;
  cfgRef.current = config;
  cbRef.current = onBpmChange;

  // Reset the counter whenever trainer is (re)enabled so users get a clean
  // "from now, every N bars" experience when they flip it on mid-play.
  useEffect(() => {
    if (config.enabled) {
      barsRef.current = 0;
      firstBeatRef.current = true;
    }
  }, [config.enabled]);

  useEffect(() => {
    if (!engine.isPlaying) {
      barsRef.current = 0;
      firstBeatRef.current = true;
      return;
    }
    return engine.onBeat((beatDot) => {
      if (beatDot !== 0) return;
      if (firstBeatRef.current) {
        firstBeatRef.current = false;
        return;
      }
      barsRef.current += 1;
      const next = trainerNextBpm({
        barsCompleted: barsRef.current,
        currentBpm: bpmRef.current,
        config: cfgRef.current,
      });
      if (next !== null) cbRef.current(next);
    });
  }, [engine]);
};
