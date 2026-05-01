import { useEffect, useMemo, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';

import { accent } from '../theme/accent';
import { IconButton } from './IconButton';
import { PauseIcon, PlayIcon, WaveformIcon } from './icons';

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
};

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
}: AudioPlayerProps) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(durationHint ?? 0);
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
    if (a) setCurrent(a.currentTime);
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
    setPlaying(false);
    setCurrent(0);
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
  children,
}: WaveformProps) => {
  const bars = useMemo(() => {
    const seed = hashSrc(src);
    return Array.from({ length: 48 }, (_, i) => {
      const t = i / 48;
      return 0.35 + 0.55 * Math.abs(Math.sin(t * Math.PI * 5 + seed));
    });
  }, [src]);
  const progress = duration > 0 ? Math.min(1, current / duration) : 0;

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    onSeek(e.clientX, e.currentTarget.getBoundingClientRect());
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return;
    onSeek(e.clientX, e.currentTarget.getBoundingClientRect());
  };

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
          className="flex-1 min-w-0 flex items-end gap-[2px] h-10 cursor-pointer select-none overflow-hidden"
          aria-hidden
          onPointerDown={onDown}
          onPointerMove={onMove}
        >
          {bars.map((h, i) => {
            const lit = i / bars.length <= progress;
            return (
              <span
                key={i}
                style={{
                  flex: 1,
                  minWidth: 1,
                  height: `${h * 100}%`,
                  background: lit ? accent(0.9) : 'rgba(255,255,255,0.18)',
                  borderRadius: 1,
                  transition: 'background 120ms linear',
                }}
              />
            );
          })}
        </div>
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
