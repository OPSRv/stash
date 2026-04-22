import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { accent } from '../../shared/theme/accent';
import { Button } from '../../shared/ui/Button';
import { Select } from '../../shared/ui/Select';
import { MicIcon, StopCircleIcon } from '../../shared/ui/icons';

const MIC_PREF_KEY = 'stash:notes:micDeviceId';

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
    /* storage may be unavailable (private mode, disabled) — silently skip. */
  }
};

/** Continuity mics expose the iPhone's device name (e.g. "Sasha's iPhone
 *  Microphone"). Detecting by substring is fragile in theory but in practice
 *  macOS always includes the word — and the user can override via the picker. */
const isIphoneLabel = (label: string): boolean => /iphone/i.test(label);

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

import { formatDuration } from '../../shared/format/duration';

const formatClock = (ms: number): string =>
  formatDuration(ms, { unit: 'ms', includeHours: 'never' });

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
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startedAtRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const formatRef = useRef<{ mime: string; ext: string }>({ mime: '', ext: 'webm' });
  /** Whether we've already auto-switched to an iPhone on this open. Prevents
   *  the picker from yanking the stream back every time enumerateDevices
   *  re-runs (e.g. device hotplug while recording). */
  const autoSwitchedRef = useRef(false);

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
      autoSwitchedRef.current = false;
    }
  }, [open, cleanup]);

  useEffect(() => () => cleanup(), [cleanup]);

  const refreshDevices = useCallback(async (): Promise<MediaDeviceInfo[]> => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const mics = all.filter((d) => d.kind === 'audioinput');
      setDevices(mics);
      return mics;
    } catch {
      return [];
    }
  }, []);

  const start = useCallback(async (deviceId?: string | null) => {
    setErrorMsg(null);
    /** If a saved or requested device is no longer available, `exact` throws
     *  `OverconstrainedError`. Fall through to the default mic in that case. */
    const openStream = async (wanted: string | null): Promise<MediaStream> => {
      if (wanted) {
        try {
          return await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { exact: wanted } },
          });
        } catch (e) {
          const err = e as DOMException;
          if (err?.name !== 'OverconstrainedError' && err?.name !== 'NotFoundError') throw e;
          saveMic(null);
        }
      }
      return navigator.mediaDevices.getUserMedia({ audio: true });
    };
    try {
      const wanted = deviceId ?? readSavedMic();
      const stream = await openStream(wanted);
      streamRef.current = stream;
      const activeId = stream.getAudioTracks()[0]?.getSettings?.().deviceId ?? null;
      setActiveDeviceId(activeId);

      // Cache the resolved device as the user's preference so the next open
      // skips the full "enumerate → possibly re-open for iPhone" dance and
      // goes straight to `exact` the moment `getUserMedia` is available.
      // Without this, every recorder open paid a ~1s startup cost to redo
      // the same discovery. Only fill it in if nothing was saved before, to
      // respect an explicit manual pick from the device picker.
      if (activeId && !readSavedMic()) saveMic(activeId);

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
      // 100 ms timeslice — small enough that the first audio bytes land in
      // `chunksRef` almost immediately after `rec.start()`, so if the user
      // stops the recording within the first half-second there's still
      // something to save. 250 ms (the old value) made very short
      // clips occasionally come back empty.
      rec.start(100);
      recorderRef.current = rec;

      // Enumerate devices and auto-prefer an iPhone mic off the critical
      // path — after the user has a live stream and the UI has already
      // swapped to the "Recording" panel. This adds a device picker
      // eventually (on a laptop without Continuity) or, on the very first
      // open with an iPhone nearby, preps the saved preference so
      // subsequent opens go straight to the phone.
      if (!deviceId && !autoSwitchedRef.current) {
        autoSwitchedRef.current = true;
        void refreshDevices().then((mics) => {
          const iphone = mics.find((d) => isIphoneLabel(d.label));
          if (iphone?.deviceId && iphone.deviceId !== activeId) {
            // Remember for next open; the current recording keeps running
            // on whatever mic we already captured — no mid-clip swap.
            saveMic(iphone.deviceId);
          }
        });
      } else {
        void refreshDevices();
      }

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
  }, [cleanup, refreshDevices]);

  // Auto-start the recording when the modal opens.
  useEffect(() => {
    if (open && state === 'idle') {
      start();
    }
  }, [open, state, start]);

  const changeDevice = useCallback(
    async (nextId: string) => {
      if (!nextId || nextId === activeDeviceId) return;
      saveMic(nextId);
      // Tear down the current recording and restart cleanly on the new input.
      // Elapsed resets — this is consistent with how macOS apps handle mid-
      // recording input switches, and clearer than trying to splice two streams.
      const rec = recorderRef.current;
      if (rec && rec.state !== 'inactive') {
        try {
          rec.stop();
        } catch {
          /* already stopped */
        }
      }
      cleanup();
      setElapsedMs(0);
      setLevels([]);
      setState('idle');
      await start(nextId);
    },
    [activeDeviceId, cleanup, start]
  );

  const deviceOptions = useMemo(
    () =>
      devices.map((d, i) => ({
        value: d.deviceId || `__dev_${i}`,
        label: d.label || `Microphone ${i + 1}`,
      })),
    [devices]
  );

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
      style={{
        background: 'rgba(0,0,0,0.65)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
      }}
    >
      <div
        className="modal-surface rounded-xl p-6 w-[380px] flex flex-col items-center gap-4"
        style={{
          boxShadow: '0 20px 60px -10px rgba(0,0,0,0.55)',
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
                    background: accent(0.7),
                    borderRadius: 1,
                    transition: 'height 40ms linear',
                  }}
                />
              ))}
            </div>
            {deviceOptions.length > 1 && activeDeviceId && (
              <div
                className="flex items-center gap-2 w-full"
                data-testid="recorder-device-row"
              >
                <span className="t-secondary text-meta shrink-0">Mic</span>
                <Select
                  label="Microphone"
                  value={activeDeviceId}
                  onChange={changeDevice}
                  options={deviceOptions}
                  placement="auto"
                />
              </div>
            )}
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
