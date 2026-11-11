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
  const tickerRef = useRef<WorkerTicker | null>(null);
  const cfgRef = useRef(cfg);
  const listenersRef = useRef<Set<(beatDot: number, accent: boolean) => void>>(new Set());
  const currentBeatRef = useRef<number>(0);
  /// Pending on-beat `setTimeout` ids so `stop()` can cancel queued flashes
  /// instead of letting the beat strip pulse for up to `SCHEDULE_AHEAD_S`
  /// after the user hit Stop.
  const pendingBeatTimersRef = useRef<Set<number>>(new Set());
  /// Recovers a wedged shared context (see `audioClock.ts`).
  const watchdogRef = useRef(createStallWatchdog());

  cfgRef.current = cfg;

  const ensureCtx = (): AudioContext => {
    if (!ctxRef.current) {
      // Shared, app-wide context — see `sharedAudioContext.ts`. Using our own
      // context here is what let the Recorder's mic-open renegotiate the device
      // rate out from under a running metronome ("тупить when recorder starts").
      ctxRef.current = getSharedAudioContext();
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
    // Self-heal a stalled audio graph — WKWebView suspends/'interrupts' the
    // context (app deactivation, device sleep/wake, headphone swap, another
    // context or the mic renegotiating the output) and can even leave it
    // 'running' with a frozen clock: the strip would pulse while the speaker
    // stays silent. The watchdog resumes, and rebuilds the context when
    // resume() can't revive it (→ onSharedAudioContextReplaced below).
    const verdict = watchdogRef.current.check(ctx);
    if (verdict === 'suspended' || verdict === 'recreated') {
      // While suspended `currentTime` is frozen, so re-pin the next note a
      // hair ahead to avoid a burst of past-due clicks on resume.
      if (verdict === 'suspended') nextNoteTimeRef.current = ctx.currentTime + 0.05;
      return;
    }
    const { bpm, subdivision } = cfgRef.current;
    const interval = tickInterval(bpm, subdivision);
    while (nextNoteTimeRef.current < ctx.currentTime + SCHEDULE_AHEAD_S) {
      scheduleNote(nextNoteTimeRef.current, beatIdxRef.current);
      nextNoteTimeRef.current += interval;
      beatIdxRef.current += 1;
    }
  }, [scheduleNote]);

  const ensureTicker = useCallback((): WorkerTicker => {
    if (!tickerRef.current) tickerRef.current = createWorkerTicker(() => scheduler(), LOOKAHEAD_MS);
    return tickerRef.current;
  }, [scheduler]);

  const start = useCallback(() => {
    const ctx = ensureCtx();
    ctx.resume().catch(() => {});
    nextNoteTimeRef.current = ctx.currentTime + 0.05;
    beatIdxRef.current = 0;
    watchdogRef.current.reset();
    setIsPlaying(true);
    ensureTicker().start();
  }, [ensureTicker]);

  const stop = useCallback(() => {
    tickerRef.current?.stop();
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
      tickerRef.current?.dispose();
      tickerRef.current = null;
      for (const h of pendingBeatTimersRef.current) window.clearTimeout(h);
      pendingBeatTimersRef.current.clear();
      // Detach our master from the *shared* context — never close it, other
      // modules (Recorder, Tuner, …) may still be using the same graph.
      masterRef.current?.disconnect();
      masterRef.current = null;
      ctxRef.current = null;
    };
  }, []);

  // Resume the AudioContext when the popup tab becomes visible again.
  // macOS suspends inactive WKWebView audio graphs aggressively — without
  // this hop the metronome would visibly tick (worker keeps firing) but
  // the speaker stays silent until the user toggles play/pause. Read
  // `isPlaying` via a ref so the listener stays bound across renders and
  // doesn't re-register when the user changes BPM mid-play.
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);
  // Another module (or our own watchdog) rebuilt the shared context: our
  // master gain belongs to the dead one, so re-attach to the new context and
  // re-pin the schedule if we're mid-play.
  useEffect(
    () =>
      onSharedAudioContextReplaced(() => {
        masterRef.current?.disconnect();
        masterRef.current = null;
        ctxRef.current = null;
        if (!isPlayingRef.current) return;
        const ctx = ensureCtx();
        nextNoteTimeRef.current = ctx.currentTime + 0.05;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ensureCtx only touches refs
    [],
  );

  // A context rebuilt outside a user gesture may be held 'suspended' by the
  // autoplay policy — the next click/key anywhere in the popup unlocks it.
  useEffect(() => {
    const unlock = () => {
      if (!isPlayingRef.current) return;
      const ctx = ctxRef.current;
      if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
    };
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
    return () => {
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
    };
  }, []);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      if (!isPlayingRef.current) return;
      const ctx = ctxRef.current;
      if (!ctx || ctx.state !== 'suspended') return;
      ctx.resume().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const onBeat: EngineHandle['onBeat'] = useCallback((cb) => {
    listenersRef.current.add(cb);
    return () => {
      listenersRef.current.delete(cb);
    };
  }, []);

  return { isPlaying, start, stop, toggle, currentBeatRef, onBeat };
};
