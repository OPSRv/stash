import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { MicIcon, StopCircleIcon } from '../../shared/ui/icons';

export type RecordedAudio = {
  bytes: Uint8Array;
  ext: string;
  durationMs: number;
};

type Props = {
  open: boolean;
  onCancel: () => void;
  onComplete: (result: RecordedAudio) => void;
};

/** Mime-type / file-extension pairs we try in order of preference.
 *
 *  **Order matters** — the Rust transcription pipeline uses Symphonia, which
 *  does not yet decode Opus. We therefore prefer containers that carry a
 *  codec Symphonia handles (AAC, Vorbis, PCM), and keep Opus only as a
 *  last-ditch fallback for browsers that refuse everything else. On WKWebView
 *  (macOS) `audio/mp4` with AAC is the native choice and works out of the
 *  box; Chromium falls through to webm/opus and the user sees a clear
 *  "re-record in a supported format" error from the backend. */
const CANDIDATES: { mime: string; ext: string }[] = [
  { mime: 'audio/mp4;codecs=mp4a.40.2', ext: 'mp4' },
  { mime: 'audio/mp4', ext: 'mp4' },
  { mime: 'audio/ogg;codecs=vorbis', ext: 'ogg' },
  { mime: 'audio/wav', ext: 'wav' },
  { mime: 'audio/webm;codecs=opus', ext: 'webm' },
  { mime: 'audio/webm', ext: 'webm' },
];

const pickFormat = (): { mime: string; ext: string } => {
  const ctor = typeof MediaRecorder !== 'undefined' ? MediaRecorder : null;
  if (!ctor) return { mime: '', ext: 'webm' };
  for (const c of CANDIDATES) {
    if (ctor.isTypeSupported?.(c.mime)) return c;
  }
  return { mime: '', ext: 'webm' };
};

const formatClock = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

/** Normalized [0..1] loudness sample from an `AnalyserNode`. Simple RMS over
 *  the time-domain buffer — good enough for a visual level meter. */
const readLevel = (analyser: AnalyserNode, buf: Uint8Array): number => {
  analyser.getByteTimeDomainData(buf);
  let sumSq = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sumSq += v * v;
  }
  return Math.min(1, Math.sqrt(sumSq / buf.length) * 2.5);
};

export const AudioRecorder = ({ open, onCancel, onComplete }: Props) => {
  const [state, setState] = useState<'idle' | 'recording' | 'denied' | 'error'>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startedAtRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const formatRef = useRef<{ mime: string; ext: string }>({ mime: '', ext: 'webm' });

  const cleanup = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    recorderRef.current = null;
  }, []);

  useEffect(() => {
    if (!open) {
      cleanup();
      setState('idle');
      setElapsedMs(0);
      setLevels([]);
      setErrorMsg(null);
    }
  }, [open, cleanup]);

  useEffect(() => () => cleanup(), [cleanup]);

  const start = useCallback(async () => {
    setErrorMsg(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const ctx = new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;

      const fmt = pickFormat();
      formatRef.current = fmt;
      const rec = new MediaRecorder(stream, fmt.mime ? { mimeType: fmt.mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.start(250);
      recorderRef.current = rec;

      startedAtRef.current = performance.now();
      setState('recording');
      setElapsedMs(0);
      setLevels([]);

      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        setElapsedMs(performance.now() - startedAtRef.current);
        if (analyserRef.current) {
          const lvl = readLevel(analyserRef.current, buf);
          setLevels((prev) => {
            const next = [...prev, lvl];
            // Keep ~the last 6 s of visual history (≈ 360 frames at 60fps).
            return next.length > 96 ? next.slice(next.length - 96) : next;
          });
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (e) {
      const err = e as DOMException;
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
        setState('denied');
      } else {
        setState('error');
        setErrorMsg(err?.message ?? String(e));
      }
      cleanup();
    }
  }, [cleanup]);

  // Auto-start the recording when the modal opens.
  useEffect(() => {
    if (open && state === 'idle') {
      start();
    }
  }, [open, state, start]);

  const finish = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec) {
      onCancel();
      return;
    }
    const stopped = new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
    });
    rec.stop();
    await stopped;
    const durationMs = Math.max(0, Math.round(performance.now() - startedAtRef.current));
    const blob = new Blob(chunksRef.current, {
      type: formatRef.current.mime || 'audio/webm',
    });
    if (blob.size === 0) {
      cleanup();
      setState('error');
      setErrorMsg('Recording captured no audio.');
      return;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    cleanup();
    onComplete({ bytes, ext: formatRef.current.ext, durationMs });
  }, [onComplete, onCancel, cleanup]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Record a voice note"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)' }}
    >
      <div
        className="rounded-xl p-6 w-[380px] flex flex-col items-center gap-4"
        style={{
          background: 'var(--color-surface)',
          boxShadow: '0 20px 60px -10px rgba(0,0,0,0.45)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        {state === 'recording' && (
          <>
            <div className="flex items-center gap-2 t-secondary text-meta uppercase tracking-wider">
              <span
                className="w-2 h-2 rounded-full animate-pulse"
                style={{ background: '#ef4444' }}
                aria-hidden
              />
              Recording
            </div>
            <div
              className="t-primary font-light tabular-nums"
              style={{ fontSize: 44, lineHeight: 1, letterSpacing: '-0.03em' }}
            >
              {formatClock(elapsedMs)}
            </div>
            <div
              className="flex items-end gap-[2px] h-12 w-full overflow-hidden rounded-md px-1"
              style={{ background: 'rgba(255,255,255,0.04)' }}
              aria-hidden
              data-testid="recorder-meter"
            >
              {levels.slice(-64).map((lvl, i) => (
                <span
                  key={i}
                  style={{
                    flex: 1,
                    minWidth: 2,
                    height: `${Math.max(6, lvl * 100)}%`,
                    background: 'rgba(var(--stash-accent-rgb), 0.7)',
                    borderRadius: 1,
                    transition: 'height 40ms linear',
                  }}
                />
              ))}
            </div>
            <div className="flex items-center gap-2 w-full justify-center mt-1">
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
              <Button
                variant="soft"
                tone="accent"
                onClick={finish}
                className="gap-2"
                data-testid="recorder-stop"
              >
                <StopCircleIcon size={14} />
                Stop & save
              </Button>
            </div>
          </>
        )}
        {state === 'idle' && (
          <div className="flex items-center gap-3 t-secondary text-body">
            <MicIcon size={16} />
            Preparing microphone…
          </div>
        )}
        {state === 'denied' && (
          <>
            <div className="t-primary text-heading font-medium">Microphone blocked</div>
            <p className="t-secondary text-meta text-center leading-relaxed">
              Allow microphone access for Stash in macOS&nbsp;System&nbsp;Settings → Privacy &amp; Security
              → Microphone, then try again.
            </p>
            <Button variant="soft" tone="accent" onClick={onCancel}>
              Close
            </Button>
          </>
        )}
        {state === 'error' && (
          <>
            <div className="t-primary text-heading font-medium">Couldn't record</div>
            <p className="t-secondary text-meta text-center leading-relaxed">
              {errorMsg ?? 'Unknown recording error.'}
            </p>
            <Button variant="soft" tone="accent" onClick={onCancel}>
              Close
            </Button>
          </>
        )}
      </div>
    </div>
  );
};
