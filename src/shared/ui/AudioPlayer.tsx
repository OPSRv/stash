import { useEffect, useMemo, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';

import { accent } from '../theme/accent';
import { IconButton } from './IconButton';
import { PauseIcon, PlayIcon, RepeatIcon, WaveformIcon } from './icons';

/// Load strategy.
///  - `url`    : hand `src` directly to `<audio>`. Absolute paths get
///               `convertFileSrc` (asset://); anything with a protocol
///               (asset://, file://, http) passes through. Used by
///               Telegram inbox media (lives in scope-allowed dirs).
///  - `bytes`  : read all bytes via the Notes audio-reader up-front and
///               wrap in a Blob URL. Used by short markdown voice notes.
///               Don't use for big files — IPC `Vec<u8>` JSON-array
///               serialisation is O(N) and freezes the main thread.
///  - `stream` : resolve a `http://127.0.0.1:<port>/audio?…` URL via
///               the Notes loopback media server, then stream as usual.
///               The only path AVFoundation can open for large/streaming
///               audio (asset:// fails for any sizeable file). Use this
///               for note attachments.
export type AudioLoader = 'url' | 'bytes' | 'stream';

/// Visual variant.
///  - `compact`  : 32 px tall row with a slim progress bar + clock.
///                 Fits inside dense lists (inbox rows, attachment
///                 chips).
///  - `waveform` : 48-bar decorative waveform + clock + caption.
///                 Used inline in markdown-rendered notes.
export type AudioPlayerDisplay = 'compact' | 'waveform';

type AudioPlayerProps = {
  src: string;
  loader?: AudioLoader;
  display?: AudioPlayerDisplay;
  /// Known-good duration in seconds. Used for the initial clock
  /// readout before the `<audio>` element has metadata (e.g. Telegram
  /// voice notes ship with `duration_sec` on the row).
  durationHint?: number | null;
  caption?: string;
  className?: string;
  /// Enable the A–B loop control (waveform variant only). Renders a
  /// repeat toggle plus two draggable region handles on the waveform;
  /// while looping is on, playback wraps from B back to A. Opt-in so
  /// notes / inbox players stay unchanged.
  abLoop?: boolean;
};

/// Minimum loop-region width as a fraction of the track, so the two
/// handles can never cross or collapse onto each other.
const MIN_LOOP_GAP = 0.02;

const fmt = (s: number): string => {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const total = Math.floor(s);
  const m = Math.floor(total / 60);
  const ss = total % 60;
  return `${m}:${ss.toString().padStart(2, '0')}`;
};

/// Lightweight stable hash for deterministic waveform seeds.
const hashSrc = (src: string): number => {
  let h = 0;
  for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) | 0;
  return h;
};

const mimeFor = (path: string): string => {
  const ext = path.split(/[?#]/)[0].split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'mp4':
    case 'm4a':
    case 'aac':
      return 'audio/mp4';
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'ogg':
    case 'opus':
      return 'audio/ogg';
    case 'webm':
      return 'audio/webm';
    case 'flac':
      return 'audio/flac';
    case 'aiff':
    case 'aif':
      return 'audio/aiff';
    default:
      return 'audio/mp4';
  }
};

const normaliseUrl = (src: string): string => {
  if (/^[a-z]+:\/\//i.test(src) || src.startsWith('data:') || src.startsWith('blob:')) {
    return src;
  }
  // Absolute filesystem path → Tauri asset protocol. Relative paths
  // we leave alone (usually a test fixture or an in-memory Blob URL).
  if (src.startsWith('/')) return convertFileSrc(src);
  return src;
};

/// Fallback `<audio>` bytes-loader. Imported lazily to keep the shared
/// UI layer free of a direct Notes dependency; callers pass
/// `loader="bytes"` only from contexts where that reader exists.
const loadBytes = async (src: string): Promise<Uint8Array> => {
  const { notesReadAudioByPath } = await import('../../modules/notes/api');
  // Decode once — react-markdown URL-encodes spaces before handing the
  // src to <img>, which would otherwise miss the managed audio dir.
  let decoded = src;
  try {
    decoded = decodeURI(src);
  } catch {
    /* leave src as-is */
  }
  return notesReadAudioByPath(decoded);
};

/// Unified audio player. One component, two visual variants, two load
/// strategies — replaces the standalone `MarkdownAudioPlayer` (notes
/// preview), the bespoke player inside `VoiceItem` (telegram inbox)
/// and the native `<audio controls>` used for note attachments.
export const AudioPlayer = ({
  src,
  loader = 'url',
  // Waveform is the default — even in dense lists a small bar chart
  // reads better than a hairline progress strip, and the visual
  // "this is audio" cue beats saving 16 px of vertical real estate.
  // Pass `display="compact"` when a callsite genuinely needs the
  // hairline variant (currently nobody does).
  display = 'waveform',
  durationHint,
  caption,
  className,
  abLoop = false,
}: AudioPlayerProps) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(durationHint ?? 0);
  // A–B loop state. Region bounds are kept as fractions (0..1) so they
  // survive the duration arriving late from `loadedmetadata`.
  const [loopOn, setLoopOn] = useState(false);
  const [loopStart, setLoopStart] = useState(0);
  const [loopEnd, setLoopEnd] = useState(1);
  // Read latest loop state inside the imperative `<audio>` callbacks
  // without re-binding them every render.
  const loopRef = useRef({ on: false, start: 0, end: 1 });
  loopRef.current = { on: loopOn, start: loopStart, end: loopEnd };
  // For `bytes` loader: holds the Blob URL currently rendered.
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // For `stream` loader: holds the loopback URL minted by Rust.
  const [streamUrl, setStreamUrl] = useState<string | null>(null);

  // Keep the caller-provided duration hint authoritative until the
  // audio element reports something more precise.
  useEffect(() => {
    if (durationHint && durationHint > 0) setDuration(durationHint);
  }, [durationHint]);

  const shouldLoadBytes = loader === 'bytes';
  const shouldStream = loader === 'stream';

  useEffect(() => {
    if (!shouldLoadBytes) return;
    // `AbortController` over a bare cancellation flag so future callers
    // that hand the signal down to `fetch` / `invoke` get free abort
    // semantics — and the cleanup path is symmetric with the `stream`
    // loader below.
    const ctrl = new AbortController();
    let revoke: string | null = null;
    setBlobUrl(null);
    setLoadError(null);
    setPlaying(false);
    setCurrent(0);
    if (!durationHint) setDuration(0);
    loadBytes(src)
      .then((bytes) => {
        if (ctrl.signal.aborted) return;
        if (!bytes || bytes.byteLength === 0) {
          setLoadError('Empty audio file');
          return;
        }
        const blob = new Blob([new Uint8Array(bytes)], { type: mimeFor(src) });
        const u = URL.createObjectURL(blob);
        revoke = u;
        setBlobUrl(u);
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      ctrl.abort();
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [src, shouldLoadBytes, durationHint]);

  useEffect(() => {
    if (!shouldStream) return;
    const ctrl = new AbortController();
    setStreamUrl(null);
    setLoadError(null);
    setPlaying(false);
    setCurrent(0);
    if (!durationHint) setDuration(0);
    let decoded = src;
    try {
      decoded = decodeURI(src);
    } catch {
      /* leave src as-is */
    }
    import('../../modules/notes/api')
      .then(({ notesAudioStreamUrl }) => notesAudioStreamUrl(decoded))
      .then((u) => {
        if (!ctrl.signal.aborted) setStreamUrl(u);
      })
      .catch((e) => {
        if (!ctrl.signal.aborted) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      ctrl.abort();
    };
  }, [src, shouldStream, durationHint]);

  // Pick the live source for `<audio>`: bytes blob > stream URL > as-is.
  const audioUrl = shouldLoadBytes
    ? blobUrl
    : shouldStream
      ? streamUrl
      : normaliseUrl(src);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => {});
    else a.pause();
  };

  const onTimeUpdate = () => {
    const a = audioRef.current;
    if (!a) return;
    const { on, start, end } = loopRef.current;
    // Wrap B→A a touch early: `timeupdate` fires every ~250ms, so the
    // exact `currentTime >= b` moment is usually overshot — clamp on the
    // approach instead of waiting for `ended`.
    if (on && a.duration > 0 && a.currentTime >= end * a.duration - 0.05) {
      a.currentTime = start * a.duration;
    }
    setCurrent(a.currentTime);
  };
  const onLoadedMeta = () => {
    const a = audioRef.current;
    if (!a) return;
    const d = a.duration;
    if (Number.isFinite(d) && d > 0 && (!durationHint || durationHint <= 0)) {
      setDuration(d);
    }
  };
  const onEnded = () => {
    const a = audioRef.current;
    const { on, start } = loopRef.current;
    // Region ending exactly at the track end (B = 1) reaches `ended`
    // before `timeupdate` can wrap it — restart from A and keep going.
    if (a && on && a.duration > 0) {
      a.currentTime = start * a.duration;
      void a.play().catch(() => {});
      return;
    }
    setPlaying(false);
    setCurrent(0);
  };

  const toggleLoop = () => {
    const a = audioRef.current;
    setLoopOn((on) => {
      const next = !on;
      // Turning the loop on while parked outside the region would play
      // dead air until B; jump the playhead to A so it starts in-region.
      if (next && a && a.duration > 0) {
        const t = a.currentTime / a.duration;
        if (t < loopStart || t > loopEnd) a.currentTime = loopStart * a.duration;
      }
      return next;
    });
  };

  const changeLoop = (start: number, end: number) => {
    setLoopStart(start);
    setLoopEnd(end);
  };

  /// Surface the underlying `MediaError` code so a generic "Decode
  /// error" can't hide whether the problem is network/scope (code 2/4)
  /// or the actual codec pipeline (code 3).
  const formatMediaError = (el: HTMLAudioElement): string => {
    const e = el.error;
    if (!e) return 'Decode error';
    const codeName =
      e.code === 1
        ? 'aborted'
        : e.code === 2
          ? 'network'
          : e.code === 3
            ? 'decode'
            : e.code === 4
              ? 'unsupported'
              : `code-${e.code}`;
    return e.message ? `${codeName}: ${e.message}` : codeName;
  };

  const onAudioError = (el: HTMLAudioElement) => {
    setLoadError(formatMediaError(el));
  };

  const seekFromPointer = (clientX: number, rect: DOMRect) => {
    const a = audioRef.current;
    if (!a || duration <= 0) return;
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    a.currentTime = pct * duration;
    setCurrent(a.currentTime);
  };

  const ready = !!audioUrl && !loadError;
  const progress = duration > 0 ? Math.min(1, current / duration) : 0;

  if (display === 'waveform') {
    return (
      <WaveformDisplay
        src={src}
        caption={caption}
        playing={playing}
        duration={duration}
        current={current}
        ready={ready}
        loadError={loadError}
        onToggle={toggle}
        onSeek={seekFromPointer}
        className={className}
        abLoop={abLoop}
        loopOn={loopOn}
        loopStart={loopStart}
        loopEnd={loopEnd}
        onToggleLoop={toggleLoop}
        onChangeLoop={changeLoop}
      >
        {audioUrl && (
          <audio
            ref={audioRef}
            src={audioUrl}
            preload="metadata"
            onLoadedMetadata={onLoadedMeta}
            onTimeUpdate={onTimeUpdate}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={onEnded}
            onError={(e) => onAudioError(e.currentTarget)}
          />
        )}
      </WaveformDisplay>
    );
  }

  return (
    <div className={`flex items-center gap-3 ${className ?? ''}`}>
      <button
        type="button"
        onClick={toggle}
        disabled={!ready}
        aria-label={playing ? 'Pause' : 'Play'}
        className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-colors disabled:opacity-40"
        style={{
          backgroundColor: accent(0.18),
          color: 'rgb(var(--stash-accent-rgb))',
        }}
      >
        {playing ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M7 5v14l12-7z" />
          </svg>
        )}
      </button>
      <div
        role="slider"
        tabIndex={0}
        aria-label="Audio progress"
        aria-valuemin={0}
        aria-valuemax={Math.max(1, Math.round(duration))}
        aria-valuenow={Math.round(current)}
        onClick={(e) =>
          seekFromPointer(e.clientX, e.currentTarget.getBoundingClientRect())
        }
        className="flex-1 h-1.5 rounded-full [background:var(--bg-row-active)] overflow-hidden cursor-pointer"
      >
        <div
          className="h-full rounded-full transition-[width]"
          style={{
            width: `${progress * 100}%`,
            backgroundColor: 'rgb(var(--stash-accent-rgb))',
          }}
        />
      </div>
      <span className="text-[11px] font-mono text-white/50 tabular-nums shrink-0">
        {fmt(current)} / {fmt(duration)}
      </span>
      {audioUrl && (
        <audio
          ref={audioRef}
          src={audioUrl}
          preload="metadata"
          onLoadedMetadata={onLoadedMeta}
          onTimeUpdate={onTimeUpdate}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={onEnded}
          onError={(e) => onAudioError(e.currentTarget)}
        />
      )}
      {loadError && (
        <span
          className="text-[11px] text-rose-300/90 truncate max-w-[140px]"
          title={loadError}
        >
          ⚠ {loadError}
        </span>
      )}
    </div>
  );
};

type WaveformProps = {
  src: string;
  caption?: string;
  playing: boolean;
  duration: number;
  current: number;
  ready: boolean;
  loadError: string | null;
  onToggle: () => void;
  onSeek: (clientX: number, rect: DOMRect) => void;
  className?: string;
  abLoop: boolean;
  loopOn: boolean;
  loopStart: number;
  loopEnd: number;
  onToggleLoop: () => void;
  onChangeLoop: (start: number, end: number) => void;
  children: React.ReactNode;
};

const WaveformDisplay = ({
  src,
  caption,
  playing,
  duration,
  current,
  ready,
  loadError,
  onToggle,
  onSeek,
  className,
  abLoop,
  loopOn,
  loopStart,
  loopEnd,
  onToggleLoop,
  onChangeLoop,
  children,
}: WaveformProps) => {
  // Single pointer surface for the whole strip: a press near a loop
  // marker grabs it, anywhere else scrubs. One capture target removes
  // the seek-vs-drag races the old split handlers suffered from.
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<'A' | 'B' | 'seek' | null>(null);
  // A–B handles are meaningful only once we know the duration and the
  // caller opted in.
  const showRegion = abLoop && loopOn && ready && duration > 0;
  // Press within this many px of a marker grabs it instead of seeking.
  const GRAB_PX = 14;

  const fracAt = (clientX: number): number => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };
  // Clamp each marker so the region keeps a minimum width and stays in
  // [0,1]; works for both pointer drags and keyboard nudges.
  const setA = (frac: number) =>
    onChangeLoop(Math.max(0, Math.min(frac, loopEnd - MIN_LOOP_GAP)), loopEnd);
  const setB = (frac: number) =>
    onChangeLoop(loopStart, Math.min(1, Math.max(frac, loopStart + MIN_LOOP_GAP)));

  const onSurfaceDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!ready || duration <= 0) return;
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    surfaceRef.current?.setPointerCapture(e.pointerId);
    const frac = fracAt(e.clientX);
    if (showRegion) {
      const dA = Math.abs(frac - loopStart) * rect.width;
      const dB = Math.abs(frac - loopEnd) * rect.width;
      if (Math.min(dA, dB) <= GRAB_PX) {
        // Bias to A only on a genuine tie so the two markers stay
        // independently grabbable even when sitting close together.
        drag.current = dA <= dB ? 'A' : 'B';
        drag.current === 'A' ? setA(frac) : setB(frac);
        return;
      }
    }
    drag.current = 'seek';
    onSeek(e.clientX, rect);
  };
  const onSurfaceMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    if (drag.current === 'seek') {
      const rect = surfaceRef.current?.getBoundingClientRect();
      if (rect) onSeek(e.clientX, rect);
    } else {
      const frac = fracAt(e.clientX);
      drag.current === 'A' ? setA(frac) : setB(frac);
    }
  };
  const onSurfaceUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current) surfaceRef.current?.releasePointerCapture(e.pointerId);
    drag.current = null;
  };

  const bars = useMemo(() => {
    const seed = hashSrc(src);
    return Array.from({ length: 48 }, (_, i) => {
      const t = i / 48;
      return 0.35 + 0.55 * Math.abs(Math.sin(t * Math.PI * 5 + seed));
    });
  }, [src]);
  const progress = duration > 0 ? Math.min(1, current / duration) : 0;

  return (
    <div
      className={`my-3 rounded-lg px-3 py-2.5 flex flex-col gap-2 w-full ${className ?? ''}`}
      style={{
        background: accent(0.08),
        border: `1px solid ${accent(0.22)}`,
      }}
      data-testid="audio-waveform"
    >
      {caption && (
        <div className="flex items-center gap-2 t-secondary text-meta">
          <WaveformIcon size={12} className="shrink-0" />
          <span className="truncate flex-1">{caption}</span>
        </div>
      )}
      <div className="flex items-center gap-3">
        <IconButton
          onClick={onToggle}
          title={
            loadError
              ? 'Audio failed to load'
              : !ready
                ? 'Loading audio…'
                : playing
                  ? 'Pause'
                  : 'Play'
          }
          disabled={!ready}
          stopPropagation={false}
        >
          {playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
        </IconButton>
        <div
          ref={surfaceRef}
          data-testid="waveform-surface"
          className="relative flex-1 min-w-0 h-10 cursor-pointer select-none touch-none"
          onPointerDown={onSurfaceDown}
          onPointerMove={onSurfaceMove}
          onPointerUp={onSurfaceUp}
          onPointerCancel={onSurfaceUp}
        >
          <div
            className="flex items-end gap-[2px] h-full overflow-hidden pointer-events-none"
            aria-hidden
          >
            {bars.map((h, i) => {
              const lit = i / bars.length <= progress;
              const frac = i / bars.length;
              const outside = showRegion && (frac < loopStart || frac > loopEnd);
              return (
                <span
                  key={i}
                  style={{
                    flex: 1,
                    minWidth: 1,
                    height: `${h * 100}%`,
                    background: lit ? accent(0.9) : 'rgba(255,255,255,0.18)',
                    opacity: outside ? 0.3 : 1,
                    borderRadius: 1,
                  }}
                />
              );
            })}
          </div>
          {showRegion && (
            <div
              className="absolute inset-y-0 pointer-events-none rounded-[2px]"
              style={{
                left: `${loopStart * 100}%`,
                width: `${(loopEnd - loopStart) * 100}%`,
                background: accent(0.14),
              }}
            />
          )}
          {/* Continuous playhead — carries the smooth motion the coarse
              48-bar fill can't, so scrubbing reads as precise. */}
          {ready && duration > 0 && (
            <div
              className="absolute inset-y-0 w-[2px] -translate-x-1/2 pointer-events-none rounded-full"
              style={{ left: `${progress * 100}%`, background: '#fff' }}
            />
          )}
          {showRegion && (
            <>
              <LoopHandle label="A" left={loopStart} onNudge={(d) => setA(loopStart + d)} />
              <LoopHandle label="B" left={loopEnd} onNudge={(d) => setB(loopEnd + d)} />
            </>
          )}
        </div>
        {abLoop && (
          <IconButton
            onClick={onToggleLoop}
            title={loopOn ? 'Loop region: on (drag A/B to adjust)' : 'Loop region'}
            active={loopOn}
            disabled={!ready}
            stopPropagation={false}
          >
            <RepeatIcon size={14} />
          </IconButton>
        )}
        <span className="tabular-nums shrink-0 t-secondary text-meta">
          {fmt(current)} / {duration > 0 ? fmt(duration) : '…'}
        </span>
      </div>
      {loadError && (
        <span
          className="text-meta truncate"
          style={{ color: 'rgba(239, 68, 68, 0.95)' }}
          title={`${loadError}\n\nsrc: ${src}`}
        >
          Can&rsquo;t load audio: {loadError}
        </span>
      )}
      {!ready && !loadError && (
        <span className="t-tertiary text-meta">Loading audio…</span>
      )}
      {children}
    </div>
  );
};

type LoopHandleProps = {
  label: 'A' | 'B';
  left: number;
  /// Keyboard step (fraction of the track, sign = direction). Pointer
  /// dragging is owned by the parent surface; this only handles arrows.
  onNudge: (delta: number) => void;
};

/// A/B marker: a thin accent line with a labelled knob. Pointer events
/// fall through to the parent surface (which decides grab-vs-seek), so
/// this only adds the `ew-resize` affordance and keyboard nudging.
const LoopHandle = ({ label, left, onNudge }: LoopHandleProps) => (
  <div
    role="slider"
    tabIndex={0}
    aria-label={`Loop ${label} marker`}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.round(left * 100)}
    className="absolute inset-y-0 w-3 -translate-x-1/2 cursor-ew-resize touch-none flex justify-center outline-none"
    style={{ left: `${left * 100}%` }}
    onKeyDown={(e) => {
      const step = e.shiftKey ? 0.05 : 0.01;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        onNudge(-step);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        onNudge(step);
      }
    }}
  >
    <span className="w-[2px] h-full" style={{ background: accent(0.9) }} />
    <span
      className="absolute -top-1 text-[9px] font-semibold leading-none px-1 py-px rounded-[3px] tabular-nums"
      style={{ background: accent(0.9), color: '#000' }}
    >
      {label}
    </span>
  </div>
);
