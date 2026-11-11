import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getSharedAudioContext,
  onSharedAudioContextReplaced,
} from '../../../shared/audio/sharedAudioContext';
import {
  createStallWatchdog,
  createWorkerTicker,
  type WorkerTicker,
} from '../../../shared/audio/audioClock';
import { patternLength, stepDuration, type DrumsState, type DrumVoice } from '../lib/model';
import { createMixer, triggerStep, type ChokeState, type DrumMixer } from '../lib/mixer';
import { playVoice } from '../lib/voices';

/** Lookahead scheduler (Chris Wilson), same cadence as the Metronome. */
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD_S = 0.1;

export type DrumEngine = {
  isPlaying: boolean;
  start: () => void;
  stop: () => void;
  toggle: () => void;
  /** Subscribe to "column `col` is sounding now" (UI playhead). Fires on
   *  the main thread, aligned to the audio clock. */
  onStep: (cb: (col: number) => void) => () => void;
  /** Audition one voice through its mixer channel (row-label click). */
  preview: (voice: DrumVoice) => void;
};

/** Live playback of `state` on the app-wide shared AudioContext. Reads the
 *  pattern through a ref on every tick, so edits, tempo and mixer changes
 *  apply mid-loop without restarting. */
export const useDrumEngine = (state: DrumsState): DrumEngine => {
  const [isPlaying, setIsPlaying] = useState(false);
  const isPlayingRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  const ctxRef = useRef<AudioContext | null>(null);
  const mixerRef = useRef<DrumMixer | null>(null);
  const chokeRef = useRef<ChokeState>({ openHat: null });
  /** Unswung grid time of the next column to schedule. */
  const nextGridTimeRef = useRef(0);
  const colRef = useRef(0);
  const tickerRef = useRef<WorkerTicker | null>(null);
  const watchdogRef = useRef(createStallWatchdog());
  const listenersRef = useRef(new Set<(col: number) => void>());
  const pendingRef = useRef(new Set<number>());

  const ensureGraph = (): AudioContext => {
    if (!ctxRef.current) {
      const ctx = getSharedAudioContext();
      ctxRef.current = ctx;
      mixerRef.current = createMixer(ctx, ctx.destination, stateRef.current);
      chokeRef.current = { openHat: null };
    }
    return ctxRef.current;
  };

  const dropGraph = () => {
    mixerRef.current?.disconnect();
    mixerRef.current = null;
    ctxRef.current = null;
  };

  const clearPending = () => {
    for (const h of pendingRef.current) window.clearTimeout(h);
    pendingRef.current.clear();
  };

  const scheduler = useCallback(() => {
    const ctx = ctxRef.current;
    const mixer = mixerRef.current;
    if (!ctx || !mixer) return;
    const verdict = watchdogRef.current.check(ctx);
    if (verdict === 'suspended') {
      nextGridTimeRef.current = ctx.currentTime + 0.05;
      return;
    }
    if (verdict === 'recreated') return;
    const s = stateRef.current;
    const len = patternLength(s);
    const d = stepDuration(s.bpm, s.meter);
    while (nextGridTimeRef.current < ctx.currentTime + SCHEDULE_AHEAD_S) {
      const col = colRef.current % len;
      const swung = s.meter !== '12/8' && col % 2 === 1 ? s.swing * d : 0;
      const t = nextGridTimeRef.current + swung;
      triggerStep(ctx, mixer, s, col, t, chokeRef.current);
      const handle = window.setTimeout(() => {
        pendingRef.current.delete(handle);
        listenersRef.current.forEach((cb) => cb(col));
      }, Math.max(0, (t - ctx.currentTime) * 1000));
      pendingRef.current.add(handle);
      nextGridTimeRef.current += d;
      colRef.current = (col + 1) % len;
    }
  }, []);

  const start = useCallback(() => {
    const ctx = ensureGraph();
    ctx.resume().catch(() => {});
    nextGridTimeRef.current = ctx.currentTime + 0.05;
    colRef.current = 0;
    watchdogRef.current.reset();
    isPlayingRef.current = true;
    setIsPlaying(true);
    if (!tickerRef.current) tickerRef.current = createWorkerTicker(scheduler, LOOKAHEAD_MS);
    tickerRef.current.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ensureGraph only touches refs
  }, [scheduler]);

  const stop = useCallback(() => {
    tickerRef.current?.stop();
    clearPending();
    isPlayingRef.current = false;
    setIsPlaying(false);
  }, []);

  const toggle = useCallback(() => {
    if (isPlayingRef.current) stop();
    else start();
  }, [start, stop]);

  const preview = useCallback((voice: DrumVoice) => {
    const ctx = ensureGraph();
    ctx.resume().catch(() => {});
    const mixer = mixerRef.current;
    if (mixer) playVoice(ctx, mixer.voiceOut[voice], voice, ctx.currentTime + 0.005, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ensureGraph only touches refs
  }, []);

  // Mixer knobs → live gains.
  useEffect(() => {
    mixerRef.current?.apply(state);
  }, [state]);

  // Shared context rebuilt (our watchdog or another module's): re-attach.
  useEffect(
    () =>
      onSharedAudioContextReplaced(() => {
        dropGraph();
        if (!isPlayingRef.current) return;
        const ctx = ensureGraph();
        nextGridTimeRef.current = ctx.currentTime + 0.05;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs only
    [],
  );

  // A rebuilt context may be held 'suspended' by the autoplay policy until a
  // gesture; resume on the next click/key, and when the popup shows again.
  useEffect(() => {
    const unlock = () => {
      const ctx = ctxRef.current;
      if (isPlayingRef.current && ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') unlock();
    };
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  useEffect(
    () => () => {
      tickerRef.current?.dispose();
      tickerRef.current = null;
      clearPending();
      // Detach only — never close the shared context.
      dropGraph();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount only
    [],
  );

  const onStep = useCallback<DrumEngine['onStep']>((cb) => {
    listenersRef.current.add(cb);
    return () => {
      listenersRef.current.delete(cb);
    };
  }, []);

  return { isPlaying, start, stop, toggle, onStep, preview };
};
