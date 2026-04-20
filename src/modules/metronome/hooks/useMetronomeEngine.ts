import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type MetronomeState,
  type SoundPreset,
  SOUND_PRESETS,
} from '../metronome.constants';

/** Seconds between two clicks at the given tempo + subdivision. */
export const tickInterval = (bpm: number, subdivision: number): number =>
  60 / bpm / subdivision;

type EngineConfig = Pick<
  MetronomeState,
  'bpm' | 'subdivision' | 'numerator' | 'sound' | 'click_volume' | 'accent_volume' | 'beat_accents'
>;

/** Lookahead scheduler (Chris Wilson). */
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD_S = 0.1;

/// Web Worker timer source. Browsers throttle `setInterval` on hidden tabs
/// (down to ~1Hz), which starves the lookahead scheduler and makes the
/// metronome stutter when the popup is closed. Workers aren't throttled, so
/// we run the tick clock there and post a message back to drive the
/// scheduler at full rate even when the popup is hidden.
const SCHEDULER_WORKER_SRC = `
let id = null;
self.onmessage = (e) => {
  if (e.data && e.data.type === 'start') {
    if (id !== null) clearInterval(id);
    const ms = e.data.ms || 25;
    id = setInterval(() => self.postMessage('tick'), ms);
  } else if (e.data && e.data.type === 'stop') {
    if (id !== null) { clearInterval(id); id = null; }
  }
};
`;

type EngineHandle = {
  isPlaying: boolean;
  start: () => void;
  stop: () => void;
  toggle: () => void;
  /** Index of the most recently scheduled beat (0..numerator*subdivision-1). */
  currentBeatRef: React.RefObject<number>;
  /** Subscribe to “a beat just started playing”. Receives the beat index
   *  modulo `numerator` (i.e. the dot index, ignoring subdivision). */
  onBeat: (cb: (beatDot: number, isAccent: boolean) => void) => () => void;
};

const findPreset = (id: string): SoundPreset =>
  SOUND_PRESETS.find((p) => p.id === id) ?? SOUND_PRESETS[0];

export const useMetronomeEngine = (cfg: EngineConfig): EngineHandle => {
  const [isPlaying, setIsPlaying] = useState(false);
  const ctxRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const nextNoteTimeRef = useRef<number>(0);
  const beatIdxRef = useRef<number>(0);
  const workerRef = useRef<Worker | null>(null);
  const workerUrlRef = useRef<string | null>(null);
  const cfgRef = useRef(cfg);
  const listenersRef = useRef<Set<(beatDot: number, accent: boolean) => void>>(new Set());
  const currentBeatRef = useRef<number>(0);
  /// Pending on-beat `setTimeout` ids so `stop()` can cancel queued flashes
  /// instead of letting the beat strip pulse for up to `SCHEDULE_AHEAD_S`
  /// after the user hit Stop.
  const pendingBeatTimersRef = useRef<Set<number>>(new Set());

  cfgRef.current = cfg;

  const ensureCtx = (): AudioContext => {
    if (!ctxRef.current) {
      const Ctor = (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ?? AudioContext;
      ctxRef.current = new Ctor();
      const master = ctxRef.current.createGain();
      master.gain.value = 5;
      master.connect(ctxRef.current.destination);
      masterRef.current = master;
    }
    return ctxRef.current;
  };

  const scheduleNote = useCallback((time: number, beatIdx: number) => {
    const ctx = ctxRef.current;
    const master = masterRef.current;
    if (!ctx || !master) return;
    const { numerator, subdivision, sound, click_volume, accent_volume, beat_accents } =
      cfgRef.current;
    const beatDot = Math.floor(beatIdx / subdivision) % numerator;
    const isOnBeat = beatIdx % subdivision === 0;
    const isAccent = isOnBeat && (beat_accents[beatDot] ?? false);
    const preset = findPreset(sound);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = preset.type;
    osc.frequency.value = isAccent ? preset.accentHz : preset.baseHz;
    // Soften off-beats (subdivision ticks) so they sit underneath the main pulse.
    const offBeatScale = isOnBeat ? 1 : 0.55;
    const peak = (isAccent ? accent_volume : click_volume) * offBeatScale;
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(peak, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + preset.decay);
    osc.connect(gain).connect(master);
    osc.start(time);
    osc.stop(time + preset.decay + 0.02);

    if (isOnBeat) {
      const delayMs = Math.max(0, (time - ctx.currentTime) * 1000);
      const handle = window.setTimeout(() => {
        pendingBeatTimersRef.current.delete(handle);
        currentBeatRef.current = beatDot;
        listenersRef.current.forEach((cb) => cb(beatDot, isAccent));
      }, delayMs);
      pendingBeatTimersRef.current.add(handle);
    }
  }, []);

  const scheduler = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const { bpm, subdivision } = cfgRef.current;
    const interval = tickInterval(bpm, subdivision);
    while (nextNoteTimeRef.current < ctx.currentTime + SCHEDULE_AHEAD_S) {
      scheduleNote(nextNoteTimeRef.current, beatIdxRef.current);
      nextNoteTimeRef.current += interval;
      beatIdxRef.current += 1;
    }
  }, [scheduleNote]);

  const ensureWorker = useCallback((): Worker | null => {
    if (workerRef.current) return workerRef.current;
    if (typeof Worker === 'undefined') return null;
    try {
      const blob = new Blob([SCHEDULER_WORKER_SRC], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      const w = new Worker(url);
      w.onmessage = () => scheduler();
      workerRef.current = w;
      workerUrlRef.current = url;
      return w;
    } catch {
      return null;
    }
  }, [scheduler]);

  const start = useCallback(() => {
    const ctx = ensureCtx();
    ctx.resume().catch(() => {});
    nextNoteTimeRef.current = ctx.currentTime + 0.05;
    beatIdxRef.current = 0;
    setIsPlaying(true);
    const w = ensureWorker();
    if (w) {
      w.postMessage({ type: 'start', ms: LOOKAHEAD_MS });
    }
  }, [ensureWorker]);

  const stop = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.postMessage({ type: 'stop' });
    }
    for (const h of pendingBeatTimersRef.current) window.clearTimeout(h);
    pendingBeatTimersRef.current.clear();
    setIsPlaying(false);
  }, []);

  const toggle = useCallback(() => {
    if (isPlaying) stop();
    else start();
  }, [isPlaying, start, stop]);

  // Restart the scheduling loop when the *bar structure* changes mid-play
  // (numerator/subdivision) — the scheduler reads `bpm` from `cfgRef.current`
  // on each tick, so BPM changes take effect naturally after the look-ahead
  // drains without nuking already-scheduled notes or forcing a phantom
  // accented downbeat. This keeps trainer mode's auto-increase smooth.
  useEffect(() => {
    if (!isPlaying) return;
    const ctx = ctxRef.current;
    if (!ctx) return;
    nextNoteTimeRef.current = ctx.currentTime + 0.05;
    beatIdxRef.current = 0;
  }, [cfg.subdivision, cfg.numerator, isPlaying]);

  useEffect(() => {
    return () => {
      if (workerRef.current) {
        workerRef.current.postMessage({ type: 'stop' });
        workerRef.current.terminate();
        workerRef.current = null;
      }
      if (workerUrlRef.current) {
        URL.revokeObjectURL(workerUrlRef.current);
        workerUrlRef.current = null;
      }
      for (const h of pendingBeatTimersRef.current) window.clearTimeout(h);
      pendingBeatTimersRef.current.clear();
      ctxRef.current?.close().catch(() => {});
    };
  }, []);

  const onBeat: EngineHandle['onBeat'] = useCallback((cb) => {
    listenersRef.current.add(cb);
    return () => {
      listenersRef.current.delete(cb);
    };
  }, []);

  return { isPlaying, start, stop, toggle, currentBeatRef, onBeat };
};
