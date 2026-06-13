import { useCallback, useEffect, useRef, useState } from 'react';
import { resumeSharedAudioContext } from '../../../shared/audio/sharedAudioContext';
import { shortDeviceLabel } from '../../../shared/util/deviceLabel';
import {
  GAIN_DEFAULT,
  GAIN_MAX,
  GAIN_MIN,
  GAIN_PREF_KEY,
  MIC_PREF_KEY,
  pickRecordFormat,
} from '../recorder.constants';

export type RecorderPhase = 'idle' | 'recording' | 'denied' | 'error';

export type CapturedTake = {
  bytes: number[];
  ext: string;
  durationMs: number;
  /** Human label of the input the take was captured on, when known. */
  device: string | null;
};

export type DeviceOption = { value: string; label: string };

const readSavedMic = (): string | null => {
  try {
    return localStorage.getItem(MIC_PREF_KEY);
  } catch {
    return null;
  }
};

const saveMic = (id: string | null): void => {
  try {
    if (id) localStorage.setItem(MIC_PREF_KEY, id);
    else localStorage.removeItem(MIC_PREF_KEY);
  } catch {
    /* storage may be unavailable — silently skip */
  }
};

/** Clamp an arbitrary number into the supported gain range, falling back to
 *  unity for NaN / non-finite input. */
const clampGain = (g: number): number =>
  Number.isFinite(g) ? Math.min(GAIN_MAX, Math.max(GAIN_MIN, g)) : GAIN_DEFAULT;

const readSavedGain = (): number => {
  try {
    const raw = localStorage.getItem(GAIN_PREF_KEY);
    return raw === null ? GAIN_DEFAULT : clampGain(parseFloat(raw));
  } catch {
    return GAIN_DEFAULT;
  }
};

const saveGain = (g: number): void => {
  try {
    localStorage.setItem(GAIN_PREF_KEY, String(g));
  } catch {
    /* storage may be unavailable — silently skip */
  }
};

/** Raw-capture audio constraints. The browser defaults — echo cancellation,
 *  noise suppression and auto-gain — are tuned for VoIP and in WKWebView they
 *  noticeably duck and dull the signal, which is exactly the "records too
 *  quiet" complaint. We want the full, unprocessed mic level; the in-app gain
 *  stage is the only thing allowed to scale it. */
const RAW_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

/** Normalized [0..1] loudness from an `AnalyserNode` — simple RMS, enough for
 *  a visual level meter while recording. */
const readLevel = (analyser: AnalyserNode, buf: Uint8Array): number => {
  analyser.getByteTimeDomainData(buf);
  let sumSq = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sumSq += v * v;
  }
  return Math.min(1, Math.sqrt(sumSq / buf.length) * 2.5);
};

/**
 * Inline mic → MediaRecorder capture state machine for the embedded Recorder
 * panel. Unlike the shared `useVoiceRecorder` (which re-encodes to WAV and
 * pipes straight into whisper) this one keeps the native encoded blob — the
 * media server plays it back directly — and exposes a live device picker, a
 * running clock, and a level meter. Self-contained in the module, mirroring
 * how the Metronome owns its `useMetronomeEngine`.
 */
export const useRecorderEngine = () => {
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(readSavedMic());
  const [gain, setGainState] = useState<number>(readSavedGain());

  const streamRef = useRef<MediaStream | null>(null);
  // Stream that actually feeds the recorder — the gain-staged output of
  // `MediaStreamAudioDestinationNode`, distinct from the raw mic `streamRef`.
  const recordStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startedAtRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const srcNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  // Mirrors `gain` for use inside `start`/`setGain` without re-creating the
  // callbacks (and thus the device-picker / remote effects) on every nudge.
  const gainRef = useRef(gain);
  const formatRef = useRef<{ mime: string; ext: string }>({ mime: '', ext: 'webm' });
  const deviceLabelRef = useRef<string | null>(null);
  const probedRef = useRef(false);

  const refreshDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const mics = all
        .filter((d) => d.kind === 'audioinput')
        .map((d, i) => ({
          value: d.deviceId || `__dev_${i}`,
          label: d.label ? shortDeviceLabel(d.label) : `Microphone ${i + 1}`,
        }));
      setDevices(mics);
    } catch {
      /* enumeration unavailable — picker stays empty, default mic still works */
    }
  }, []);

  /** Device *labels* are hidden by the browser until mic permission is granted
   *  — so before the first recording the picker can only show generic names.
   *  This grabs a throwaway stream to unlock the real labels so the user can
   *  pick their input *before* hitting Record. Only prompts once per mount,
   *  and only on explicit intent (opening the picker) — never on tab open. */
  const ensureLabels = useCallback(async () => {
    if (probedRef.current) return;
    probedRef.current = true;
    const nav = globalThis.navigator;
    if (!nav?.mediaDevices?.getUserMedia) return;
    try {
      const probe = await nav.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
      await refreshDevices();
    } catch {
      // Denied / unavailable — keep generic labels; Record will surface the
      // permission state with its own messaging.
      probedRef.current = false;
    }
  }, [refreshDevices]);

  // Enumerate on mount. If the mic was already granted in a past session,
  // silently unlock labels (no prompt) so the picker is useful immediately.
  useEffect(() => {
    void refreshDevices();
    const perms = (globalThis.navigator as Navigator | undefined)?.permissions;
    perms
      ?.query?.({ name: 'microphone' as PermissionName })
      .then((status) => {
        if (status.state === 'granted') void ensureLabels();
      })
      .catch(() => {
        /* permissions API unsupported (e.g. WKWebView) — labels fill in on
           first picker interaction instead */
      });
  }, [refreshDevices, ensureLabels]);

  const teardown = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      rec.ondataavailable = null;
      rec.onstop = null;
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
    chunksRef.current = [];
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (recordStreamRef.current) {
      recordStreamRef.current.getTracks().forEach((t) => t.stop());
      recordStreamRef.current = null;
    }
    // Detach our capture graph from the *shared* context but never close it —
    // the Metronome (and others) play on the same context, and closing it here
    // is exactly what would kill their audio. Disconnecting the source releases
    // the mic graph; the stream tracks are already stopped above.
    srcNodeRef.current?.disconnect();
    gainNodeRef.current?.disconnect();
    analyserRef.current?.disconnect();
    srcNodeRef.current = null;
    audioCtxRef.current = null;
    analyserRef.current = null;
    gainNodeRef.current = null;
    recorderRef.current = null;
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  const setDevice = useCallback((id: string) => {
    setDeviceId(id);
    saveMic(id);
  }, []);

  /** Set the input gain. Applies live to an in-flight recording (so the meter
   *  and the captured signal track the slider immediately) and persists for the
   *  next take. */
  const setGain = useCallback((next: number) => {
    const g = clampGain(next);
    gainRef.current = g;
    setGainState(g);
    saveGain(g);
    const node = gainNodeRef.current;
    if (node && audioCtxRef.current) {
      // Short ramp instead of a hard set — avoids a click/zipper artifact when
      // dragging the slider during capture.
      node.gain.setTargetAtTime(g, audioCtxRef.current.currentTime, 0.015);
    }
  }, []);

  const start = useCallback(async () => {
    if (phase === 'recording') return;
    setError(null);
    const nav = globalThis.navigator;
    if (!nav?.mediaDevices?.getUserMedia) {
      setError('Microphone is unavailable in this environment.');
      setPhase('error');
      return;
    }
    const wanted = deviceId ?? readSavedMic();
    let stream: MediaStream;
    try {
      stream = wanted
        ? await nav.mediaDevices.getUserMedia({
            audio: { ...RAW_AUDIO_CONSTRAINTS, deviceId: { exact: wanted } },
          })
        : await nav.mediaDevices.getUserMedia({ audio: { ...RAW_AUDIO_CONSTRAINTS } });
    } catch (e) {
      const err = e as DOMException;
      // Saved device vanished — retry on whatever the system default is.
      if (wanted && (err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError')) {
        saveMic(null);
        try {
          stream = await nav.mediaDevices.getUserMedia({ audio: { ...RAW_AUDIO_CONSTRAINTS } });
        } catch (e2) {
          return failOpen(e2);
        }
      } else {
        return failOpen(e);
      }
    }
    streamRef.current = stream;
    const track = stream.getAudioTracks()[0];
    const resolvedId = track?.getSettings?.().deviceId ?? null;
    deviceLabelRef.current = track?.label || null;
    if (resolvedId) setDeviceId(resolvedId);

    try {
      // Shared, app-wide context — opening the mic on our own context used to
      // drag the device sample rate onto the mic and stutter a running
      // metronome. Resume in case it was left suspended by the autoplay policy
      // or a macOS audio-session interruption (this `start` is a user gesture).
      const ctx = resumeSharedAudioContext();
      const src = ctx.createMediaStreamSource(stream);
      // mic → gain → { analyser (post-gain meter), destination → recorder }
      // Routing the recorder through the gain stage is what makes the slider
      // affect the *captured* signal, not just the meter. Nothing connects to
      // `ctx.destination`, so capture never bleeds into the speakers.
      const gainNode = ctx.createGain();
      gainNode.gain.value = gainRef.current;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      const dest = ctx.createMediaStreamDestination();
      src.connect(gainNode);
      gainNode.connect(analyser);
      gainNode.connect(dest);
      audioCtxRef.current = ctx;
      srcNodeRef.current = src;
      analyserRef.current = analyser;
      gainNodeRef.current = gainNode;
      recordStreamRef.current = dest.stream;

      const fmt = pickRecordFormat();
      formatRef.current = fmt;
      const rec = new MediaRecorder(dest.stream, fmt.mime ? { mimeType: fmt.mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      // 100 ms timeslice — first bytes land almost immediately so a take
      // stopped within the first half-second still has audio to save.
      rec.start(100);
      recorderRef.current = rec;
    } catch (e) {
      return failOpen(e);
    }

    // Now that permission is granted, labels resolve — refresh the picker.
    void refreshDevices();

    startedAtRef.current = performance.now();
    setElapsedMs(0);
    setLevel(0);
    setPhase('recording');

    const buf = new Uint8Array(analyserRef.current!.fftSize);
    const tick = () => {
      setElapsedMs(performance.now() - startedAtRef.current);
      if (analyserRef.current) setLevel(readLevel(analyserRef.current, buf));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    function failOpen(e: unknown) {
      const err = e as DOMException;
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
        setPhase('denied');
      } else {
        setError(err?.message ?? String(e));
        setPhase('error');
      }
      teardown();
    }
  }, [phase, deviceId, refreshDevices, teardown]);

  /** Stops the recorder and resolves the captured take (null if nothing was
   *  recorded). The caller persists it via `recorderSave`. */
  const stop = useCallback(async (): Promise<CapturedTake | null> => {
    const rec = recorderRef.current;
    if (!rec || rec.state === 'inactive') {
      teardown();
      setPhase('idle');
      return null;
    }
    const durationMs = Math.max(0, Math.round(performance.now() - startedAtRef.current));
    const stopped = new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
    });
    rec.stop();
    await stopped;
    const blob = new Blob(chunksRef.current, { type: formatRef.current.mime || 'audio/webm' });
    const device = deviceLabelRef.current;
    teardown();
    setPhase('idle');
    setElapsedMs(0);
    setLevel(0);
    if (blob.size === 0) return null;
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    return { bytes, ext: formatRef.current.ext, durationMs, device };
  }, [teardown]);

  const reset = useCallback(() => {
    teardown();
    setPhase('idle');
    setError(null);
    setElapsedMs(0);
    setLevel(0);
  }, [teardown]);

  return {
    phase,
    elapsedMs,
    level,
    error,
    devices,
    deviceId,
    setDevice,
    gain,
    setGain,
    ensureLabels,
    start,
    stop,
    reset,
  };
};
