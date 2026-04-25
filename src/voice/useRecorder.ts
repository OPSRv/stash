import { useCallback, useEffect, useRef, useState } from 'react';

/// Recording lifecycle phases the popup UI flips between. `stopping`
/// is the ~150 ms tail between "user hit stop" and the
/// `dataavailable` callback resolving — surfaced so the button can
/// disable itself instead of double-firing.
export type RecorderPhase = 'idle' | 'recording' | 'stopping';

export type RecorderResult = {
  /// Raw bytes the backend sees in `voice_transcribe`.
  bytes: Uint8Array;
  /// File extension hint (`webm` on Chromium-based webviews,
  /// `mp4`/`m4a` on WKWebView). `voice_transcribe` sanitises
  /// further so this is just a best-effort.
  extension: string;
};

type Options = {
  /// When set, the recorder watches the live RMS level and stops on
  /// its own after `silenceMs` of below-threshold audio. `null` /
  /// `undefined` keeps the recorder running until the caller stops it.
  silenceMs?: number | null;
};

/// MediaRecorder wrapper sized for the Claude-style voice capsule:
/// one Hook, one tap to start, one tap (or VAD timeout) to stop, gives
/// you the bytes ready to ship to `voice_transcribe`. Live audio
/// level is exposed so the UI can pulse the mic icon in time with the
/// caller's voice.
export function useRecorder(opts: Options = {}) {
  const { silenceMs = null } = opts;

  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);

  const mediaRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const silenceStartedAtRef = useRef<number | null>(null);
  const resolveRef = useRef<((r: RecorderResult) => void) | null>(null);
  const rejectRef = useRef<((e: Error) => void) | null>(null);

  const cleanup = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    analyserRef.current = null;
    silenceStartedAtRef.current = null;
    setLevel(0);
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  const start = useCallback(async (): Promise<RecorderResult> => {
    if (phase !== 'idle') {
      throw new Error('recorder is busy');
    }
    setError(null);
    chunksRef.current = [];

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;

    // Feature-detect supported MIME types in order of preference.
    // WKWebView on macOS doesn't expose `audio/webm`; it speaks `audio/mp4`
    // (AAC) instead. Symphonia's mp4 demuxer handles either, so we pick
    // whichever the platform actually offers.
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];
    const mimeType = candidates.find((m) =>
      // `isTypeSupported` was added a long time ago; the optional chain
      // guards against the rare environment where MediaRecorder is
      // mocked without it (notably jsdom).
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(m),
    );

    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    mediaRef.current = recorder;
    recorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    });
    recorder.addEventListener('stop', async () => {
      try {
        const blob = new Blob(chunksRef.current, {
          type: mimeType ?? 'application/octet-stream',
        });
        const buf = new Uint8Array(await blob.arrayBuffer());
        const extension = guessExtension(mimeType);
        cleanup();
        setPhase('idle');
        resolveRef.current?.({ bytes: buf, extension });
      } catch (e) {
        cleanup();
        setPhase('idle');
        rejectRef.current?.(e instanceof Error ? e : new Error(String(e)));
      } finally {
        resolveRef.current = null;
        rejectRef.current = null;
      }
    });

    // Live level metering. AudioContext + AnalyserNode is the cheapest
    // way to read the loudness of the active stream — no decode pass,
    // just a moving average over the time-domain buffer.
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyserRef.current = analyser;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);

    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) {
        const dc = v - 128;
        sum += dc * dc;
      }
      const rms = Math.sqrt(sum / buf.length) / 128; // 0..1
      setLevel(rms);

      if (silenceMs != null && silenceMs > 0) {
        // VAD: we treat anything below SILENCE_THRESHOLD as silence.
        // Once we accumulate `silenceMs` in a row, fire `stop()` so
        // the user doesn't have to. Any blip above threshold resets
        // the timer.
        const SILENCE_THRESHOLD = 0.02;
        const now = performance.now();
        if (rms < SILENCE_THRESHOLD) {
          if (silenceStartedAtRef.current == null) {
            silenceStartedAtRef.current = now;
          } else if (now - silenceStartedAtRef.current >= silenceMs) {
            // Trigger stop. Unsetting first so we don't re-enter.
            silenceStartedAtRef.current = null;
            stop();
            return;
          }
        } else {
          silenceStartedAtRef.current = null;
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    recorder.start();
    setPhase('recording');

    return new Promise<RecorderResult>((resolve, reject) => {
      resolveRef.current = resolve;
      rejectRef.current = reject;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, silenceMs, cleanup]);

  const stop = useCallback(() => {
    const r = mediaRef.current;
    if (!r || r.state !== 'recording') return;
    setPhase('stopping');
    try {
      r.stop();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      cleanup();
      setPhase('idle');
    }
  }, [cleanup]);

  const cancel = useCallback(() => {
    const r = mediaRef.current;
    if (r && r.state === 'recording') {
      try {
        r.stop();
      } catch {
        /* ignore — we throw away the bytes anyway. */
      }
    }
    chunksRef.current = [];
    cleanup();
    setPhase('idle');
    rejectRef.current?.(new Error('cancelled'));
    resolveRef.current = null;
    rejectRef.current = null;
  }, [cleanup]);

  return { phase, error, level, start, stop, cancel };
}

const guessExtension = (mimeType?: string): string => {
  if (!mimeType) return 'webm';
  if (mimeType.startsWith('audio/webm')) return 'webm';
  if (mimeType.startsWith('audio/mp4')) return 'm4a';
  if (mimeType.startsWith('audio/ogg')) return 'ogg';
  if (mimeType.startsWith('audio/wav')) return 'wav';
  return 'webm';
};
