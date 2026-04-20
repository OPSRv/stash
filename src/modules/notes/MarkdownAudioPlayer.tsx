import { useEffect, useMemo, useRef, useState } from 'react';
import { IconButton } from '../../shared/ui/IconButton';
import { PauseIcon, PlayIcon, WaveformIcon } from '../../shared/ui/icons';
import { notesReadAudioByPath } from './api';

/** Map a path's extension to a MIME the browser will honour. Matches the
 *  recorder's preferred containers; unknown falls back to `audio/mp4` which
 *  WKWebView plays reliably. */
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

const fmtClock = (secs: number): string => {
  if (!Number.isFinite(secs) || secs < 0) return '0:00';
  const total = Math.floor(secs);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

/** Stable hash of the `src` string so the decorative waveform pattern stays
 *  the same across re-renders without needing an id from the caller. */
const hashSrc = (src: string): number => {
  let h = 0;
  for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) | 0;
  return h;
};

type Props = {
  /** Absolute path to the audio file, as stored in the markdown `![](path)`
   *  reference. Must live under the managed audio dir so the Rust reader
   *  will accept it. */
  src: string;
  /** Markdown alt-text doubles as a human caption ("voice note · 14:02"). */
  caption?: string;
};

/** Inline audio player for markdown-embedded audio. Mirrors `AudioNoteView`'s
 *  proven playback mechanism (read bytes → Blob URL) so WKWebView is happy
 *  with the decode path, while shrinking the visual footprint to fit inside
 *  a running note next to paragraphs of text. */
export const MarkdownAudioPlayer = ({ src, caption }: Props) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // React-markdown URL-encodes `src` before handing it to the `img`
  // component, so a path like `/Users/…/Application Support/…` arrives as
  // `/Users/…/Application%20Support/…`. The Rust reader compares the path
  // structurally against the managed audio dir (which has a literal space),
  // and rejects the encoded form as "outside the managed audio directory".
  // Decode once so the value we hand back to Rust matches the original
  // filesystem path. `decodeURI` is intentional — it preserves `/` unlike
  // `decodeURIComponent`, so nested directories round-trip safely.
  const decodedSrc = useMemo(() => {
    try {
      return decodeURI(src);
    } catch {
      return src;
    }
  }, [src]);

  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;
    setUrl(null);
    setLoadError(null);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);

    notesReadAudioByPath(decodedSrc)
      .then((bytes) => {
        if (cancelled) return;
        if (!bytes || bytes.byteLength === 0) {
          setLoadError('Empty audio file');
          return;
        }
        const blob = new Blob([new Uint8Array(bytes)], { type: mimeFor(src) });
        const u = URL.createObjectURL(blob);
        revoke = u;
        setUrl(u);
      })
      .catch((e) => {
        if (cancelled) return;
        // Log full context — the stringified error alone loses useful detail
        // (Tauri rejects often come back as opaque strings otherwise).
        // eslint-disable-next-line no-console
        console.error('[MarkdownAudioPlayer] read bytes failed', {
          src,
          decodedSrc,
          error: e,
        });
        setLoadError(String(e));
      });
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [decodedSrc, src]);

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  };

  /** Click/drag anywhere along the waveform to seek. Pointer events cover
   *  both the initial press and drag-to-scrub without needing `mouse*` /
   *  `touch*` split handlers. */
  const seekFromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const a = audioRef.current;
    if (!a || duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const t = pct * duration;
    a.currentTime = t;
    setCurrentTime(t);
  };
  const onWaveformDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromPointer(e);
  };
  const onWaveformMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return;
    seekFromPointer(e);
  };

  const bars = useMemo(() => {
    const seed = hashSrc(src);
    // Bar count tuned for a narrow notes-preview pane (often <300 px wide).
    // 96 bars at `minWidth: 2` + 2-px gaps required ~380 px just for the
    // waveform itself, so the embed overflowed and clipped the timestamp.
    // 48 fits down to ~140 px and still reads as a continuous wave.
    return Array.from({ length: 48 }, (_, i) => {
      const t = i / 48;
      return 0.35 + 0.55 * Math.abs(Math.sin(t * Math.PI * 5 + seed));
    });
  }, [src]);
  const progress = duration > 0 ? currentTime / duration : 0;

  return (
    <div
      className="my-3 rounded-lg px-3 py-2.5 flex items-center gap-3 w-full"
      style={{
        background: 'rgba(var(--stash-accent-rgb), 0.08)',
        border: '1px solid rgba(var(--stash-accent-rgb), 0.22)',
      }}
      data-testid="md-audio-embed"
    >
      <div className="shrink-0" data-testid="md-audio-toggle">
        <IconButton
          onClick={togglePlay}
          title={
            loadError
              ? 'Audio failed to load'
              : !url
                ? 'Loading audio…'
                : playing
                  ? 'Pause'
                  : 'Play'
          }
          disabled={!url || !!loadError}
          stopPropagation={false}
        >
          {playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
        </IconButton>
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        <div className="flex items-center gap-2 t-secondary text-meta">
          <WaveformIcon size={12} />
          <span className="truncate flex-1">{caption || 'voice note'}</span>
          <span className="tabular-nums shrink-0">
            {fmtClock(currentTime)} / {duration > 0 ? fmtClock(duration) : '…'}
          </span>
        </div>
        <div
          className="flex items-end gap-[2px] h-10 cursor-pointer select-none overflow-hidden"
          aria-hidden
          data-testid="md-audio-waveform"
          onPointerDown={onWaveformDown}
          onPointerMove={onWaveformMove}
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
                  background: lit
                    ? 'rgba(var(--stash-accent-rgb), 0.9)'
                    : 'rgba(255,255,255,0.18)',
                  borderRadius: 1,
                  transition: 'background 120ms linear',
                }}
              />
            );
          })}
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
        {!url && !loadError && (
          <span className="t-tertiary text-meta">Loading audio…</span>
        )}
      </div>
      {url && (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            setDuration(Number.isFinite(d) && d > 0 ? d : 0);
          }}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onError={(e) => {
            const el = e.currentTarget;
            const code = el.error?.code;
            const msg = el.error?.message;
            // eslint-disable-next-line no-console
            console.error('[MarkdownAudioPlayer] decode failed', { src, code, msg });
            setLoadError(msg || `Decode error (code ${code ?? '?'})`);
          }}
        />
      )}
    </div>
  );
};
