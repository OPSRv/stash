import { useCallback, useEffect, useRef, useState } from 'react';
import { detectPitch } from '../lib/pitch';
import { matchChromatic } from '../tuner.constants';

/** Live snapshot of what the tuner hears — a chromatic reading, so the note is
 *  whatever pitch the mic picks up, not constrained to any tuning's strings. */
export type TunerReading = {
  /** Detected fundamental in Hz, or -1 when no pitch is present. */
  freq: number;
  /** Nearest chromatic note name (e.g. "E2"), or null when silent. */
  note: string | null;
  /** Nearest chromatic MIDI note (A4 = 69), or -1 when silent. */
  midi: number;
  /** Signed cents from that note (+ sharp, − flat). */
  cents: number;
};

const EMPTY: TunerReading = { freq: -1, note: null, midi: -1, cents: 0 };

/** FFT window — 4096 samples gives enough period length to resolve the lowest
 *  guitar strings (down to drop/7-string territory) at typical sample rates. */
const FFT_SIZE = 4096;
/** State is committed at most this often (ms) to keep the needle smooth
 *  without re-rendering the shell on every animation frame. */
const COMMIT_MS = 40;
/** EMA factor for the frequency, applied while the pitch stays close. */
const SMOOTHING = 0.3;
/** Ratio jump (≈ a quarter-tone) beyond which we snap instead of smoothing —
 *  so moving to a new string tracks instantly rather than gliding. */
const SNAP_RATIO = 0.03;

type TunerHandle = {
  listening: boolean;
  /** User-facing error (mic denied / unavailable), or null. */
  error: string | null;
  reading: TunerReading;
  /** Available audio-input devices (populated once mic permission is granted). */
  devices: MediaDeviceInfo[];
  start: () => void;
  stop: () => void;
  toggle: () => void;
};

/**
 * @param deviceId Preferred audio-input device, or null for the system default.
 */
export const useTuner = (deviceId: string | null): TunerHandle => {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState<TunerReading>(EMPTY);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  // The chosen device, read from a ref so `start` always picks up the latest
  // selection without being rebuilt (and so the restart effect can compare).
  const deviceIdRef = useRef(deviceId);

  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const bufRef = useRef<Float32Array | null>(null);
  const rafRef = useRef<number | null>(null);
  const smoothedRef = useRef<number>(-1);
  const lastCommitRef = useRef<number>(0);
  /// Bumped on every teardown so a `getUserMedia` promise that resolves after
  /// the hook was stopped/unmounted (React StrictMode double-mounts, fast
  /// toggles) can detect it lost the race and release its orphaned stream.
  const genRef = useRef<number>(0);

  // Enumerate audio-input devices. Labels are only exposed once the mic has
  // been granted (which the shell does on mount), so this is meaningful after
  // the first successful `start`.
  const refreshDevices = useCallback(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((list) => setDevices(list.filter((d) => d.kind === 'audioinput')))
      .catch(() => {});
  }, []);

  const teardown = useCallback(() => {
    genRef.current += 1;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    analyserRef.current?.disconnect();
    analyserRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    smoothedRef.current = -1;
  }, []);

  const loop = useCallback((ts: number) => {
    rafRef.current = requestAnimationFrame(loop);
    const analyser = analyserRef.current;
    const ctx = ctxRef.current;
    const buf = bufRef.current;
    if (!analyser || !ctx || !buf) return;

    analyser.getFloatTimeDomainData(buf);
    const raw = detectPitch(buf, ctx.sampleRate);

    if (raw <= 0) {
      smoothedRef.current = -1;
    } else if (
      smoothedRef.current <= 0 ||
      Math.abs(raw - smoothedRef.current) / smoothedRef.current > SNAP_RATIO
    ) {
      smoothedRef.current = raw;
    } else {
      smoothedRef.current = smoothedRef.current + SMOOTHING * (raw - smoothedRef.current);
    }

    // Throttle React state commits — the analyser runs at frame rate, but the
    // UI only needs ~25 updates/sec to look continuous.
    if (ts - lastCommitRef.current < COMMIT_MS) return;
    lastCommitRef.current = ts;

    const freq = smoothedRef.current;
    const m = freq > 0 ? matchChromatic(freq) : null;
    if (!m) {
      setReading((prev) => (prev.midi === -1 ? prev : EMPTY));
      return;
    }
    setReading({ freq, note: m.name, midi: m.midi, cents: m.cents });
  }, []);

  const start = useCallback(() => {
    if (ctxRef.current) return; // already running
    setError(null);
    const gen = genRef.current;
    const id = deviceIdRef.current;
    navigator.mediaDevices
      .getUserMedia({
        audio: {
          // Pitch accuracy demands the raw signal — the browser's voice DSP
          // would warp a sustained guitar note.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          // Pin to the chosen input when one is set; omit for the OS default.
          ...(id ? { deviceId: { exact: id } } : {}),
        },
      })
      .then((stream) => {
        // Lost the race (stopped/unmounted while the prompt was open) — drop
        // the stream we were just granted instead of leaving the mic hot.
        if (gen !== genRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const Ctor =
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
          AudioContext;
        const ctx = new Ctor();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = FFT_SIZE;
        source.connect(analyser);

        ctxRef.current = ctx;
        streamRef.current = stream;
        analyserRef.current = analyser;
        bufRef.current = new Float32Array(analyser.fftSize);
        lastCommitRef.current = 0;
        setListening(true);
        rafRef.current = requestAnimationFrame(loop);
        // Device labels are unlocked now that permission was granted.
        refreshDevices();
        // The selection changed while the permission prompt was open (e.g. a
        // saved device hydrated after we'd already started on the default) —
        // re-acquire so the live stream matches the current choice.
        if (deviceIdRef.current !== id) {
          teardown();
          start();
        }
      })
      .catch((e: unknown) => {
        if (gen !== genRef.current) return;
        const name = (e as { name?: string })?.name;
        // The pinned input vanished (unplugged, or a stale saved id) — drop the
        // constraint and fall back to the OS default rather than dead-ending.
        if (name === 'OverconstrainedError' && deviceIdRef.current) {
          deviceIdRef.current = null;
          start();
          return;
        }
        setError(
          name === 'NotAllowedError' || name === 'SecurityError'
            ? 'Microphone access denied. Allow it in System Settings → Privacy → Microphone.'
            : 'No microphone available.',
        );
        setListening(false);
      });
  }, [loop, refreshDevices, teardown]);

  const stop = useCallback(() => {
    teardown();
    setListening(false);
    setReading(EMPTY);
  }, [teardown]);

  const toggle = useCallback(() => {
    if (listening) stop();
    else start();
  }, [listening, start, stop]);

  // Re-acquire the stream when the chosen input changes mid-session, so the
  // switch takes effect live without the user toggling the mic off and on.
  useEffect(() => {
    if (deviceIdRef.current === deviceId) return;
    deviceIdRef.current = deviceId;
    if (!ctxRef.current) return; // not listening — `start` will pick it up
    teardown();
    start();
  }, [deviceId, start, teardown]);

  // Keep the device list fresh as inputs are plugged in / removed.
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return;
    md.addEventListener('devicechange', refreshDevices);
    return () => md.removeEventListener('devicechange', refreshDevices);
  }, [refreshDevices]);

  // Tear everything down when the hook unmounts (modal closed) so the mic is
  // released and the OS "listening" indicator clears.
  useEffect(() => teardown, [teardown]);

  return { listening, error, reading, devices, start, stop, toggle };
};
