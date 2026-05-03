import { useEffect, useRef, useState } from 'react';
import { mediaStreamUrl } from '../util/mediaStreamUrl';
import { Tooltip } from './Tooltip';

type VideoPlayerProps = {
  src: string;
  onClose: () => void;
};

const fmt = (s: number) => {
  if (!Number.isFinite(s)) return '0:00';
  const t = Math.max(0, Math.round(s));
  const m = Math.floor(t / 60);
  const ss = t % 60;
  return `${m}:${ss.toString().padStart(2, '0')}`;
};

const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const POSITION_STORAGE_KEY = 'stash:player:positions';

type PositionMap = Record<string, number>;

const loadPositions = (): PositionMap => {
  try {
    return JSON.parse(localStorage.getItem(POSITION_STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
};

const savePosition = (src: string, t: number) => {
  const map = loadPositions();
  if (t < 5) delete map[src];
  else map[src] = t;
  try {
    localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore quota errors — resuming is best-effort
  }
};

export const VideoPlayer = ({ src, onClose }: VideoPlayerProps) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [rate, setRate] = useState(1);
  // Resolved loopback streaming URL for the file. The `src` prop stays
  // the on-disk path (so resume positions key against a stable id),
  // and we hand the tokenised http URL to `<video>`.
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStreamUrl(null);
    setStreamError(null);
    mediaStreamUrl(src)
      .then((u) => {
        if (!cancelled) setStreamUrl(u);
      })
      .catch((e) => {
        if (!cancelled) setStreamError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      setProgress(v.currentTime);
      // Persist every 4 seconds so a crash loses at most that much progress.
      if (Math.floor(v.currentTime) % 4 === 0) savePosition(src, v.currentTime);
    };
    const onLoad = () => {
      setDuration(v.duration);
      const saved = loadPositions()[src];
      if (saved && saved > 5 && saved < v.duration - 2) {
        v.currentTime = saved;
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => savePosition(src, 0);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('loadedmetadata', onLoad);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onEnded);
    return () => {
      // Final persist when the player closes.
      savePosition(src, v.currentTime);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('loadedmetadata', onLoad);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onEnded);
    };
  }, [src]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const v = videoRef.current;
      if (!v) return;
      if (e.key === ' ') {
        e.preventDefault();
        if (v.paused) v.play();
        else v.pause();
      } else if (e.key === 'ArrowLeft') {
        v.currentTime = Math.max(0, v.currentTime - 5);
      } else if (e.key === 'ArrowRight') {
        v.currentTime = Math.min(v.duration, v.currentTime + 5);
      } else if (e.key === 'Escape') {
        // Capture-phase + stopImmediatePropagation so PopupShell's
        // window Esc handler doesn't hide the whole Stash popup behind
        // the player. Same fix as `Modal`/`Lightbox`.
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
        onClose();
      } else if (e.key === 'f' || e.key === 'F') {
        if (document.fullscreenElement) document.exitFullscreen();
        else v.requestFullscreen();
      } else if (e.key === 'm' || e.key === 'M') {
        v.muted = !v.muted;
      } else if (e.key === '+' || e.key === '=') {
        const next = Math.min(2, Math.round((v.playbackRate + 0.25) * 100) / 100);
        v.playbackRate = next;
        setRate(next);
      } else if (e.key === '-' || e.key === '_') {
        const next = Math.max(0.25, Math.round((v.playbackRate - 0.25) * 100) / 100);
        v.playbackRate = next;
        setRate(next);
      } else if (e.key === 'p' || e.key === 'P') {
        // Picture-in-Picture — quietly ignore if unsupported.
        if (document.pictureInPictureElement) {
          document.exitPictureInPicture().catch(() => {});
        } else if ((v as HTMLVideoElement).requestPictureInPicture) {
          (v as HTMLVideoElement).requestPictureInPicture().catch(() => {});
        }
      } else if (/^[0-9]$/.test(e.key)) {
        // Seek to N*10% of duration.
        v.currentTime = (Number(e.key) / 10) * v.duration;
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onClose]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  };

  const seek = (pct: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = duration * pct;
  };

  const changeVolume = (vv: number) => {
    setVolume(vv);
    if (videoRef.current) videoRef.current.volume = vv;
  };

  const toggleFullscreen = () => {
    const v = videoRef.current;
    if (!v) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else v.requestFullscreen();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.85)' }}
      onClick={onClose}
    >
      <div
        className="relative max-w-[90vw] max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {streamError ? (
          <div
            className="max-h-[80vh] rounded-lg flex items-center justify-center text-meta px-6 py-10"
            style={{ background: 'rgba(28,28,32,0.92)', color: 'rgba(239,68,68,0.95)' }}
          >
            Can&rsquo;t play this file: {streamError}
          </div>
        ) : (
          <video
            ref={videoRef}
            // Loopback `http://127.0.0.1:<port>/video?...` from the
            // shared media server. AVFoundation refuses to stream
            // `asset://` past a few MB on macOS, so every video in
            // the app routes through the loopback server. Subtitles
            // would need the same treatment but downloads no longer
            // ship sibling `.vtt` next to the media in the managed
            // dirs we register, so the `<track>` element is dropped
            // here — re-add once the server exposes a `/text` route.
            src={streamUrl ?? undefined}
            className="max-h-[80vh] rounded-lg"
            autoPlay
            onClick={togglePlay}
          />
        )}

        {/* Controls */}
        <div className="mt-2 px-3 py-2 rounded-lg flex items-center gap-3" style={{ background: 'rgba(28,28,32,0.92)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <button onClick={togglePlay} className="t-primary">
            {playing ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>
          <span className="t-secondary text-meta font-mono tabular-nums">{fmt(progress)}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={duration > 0 ? progress / duration : 0}
            onChange={(e) => seek(Number(e.currentTarget.value))}
            className="flex-1 accent-accent"
          />
          <span className="t-tertiary text-meta font-mono tabular-nums">{fmt(duration)}</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="t-tertiary">
            <path d="M11 5 6 9H2v6h4l5 4V5zM19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
          </svg>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => changeVolume(Number(e.currentTarget.value))}
            className="w-20 accent-accent"
          />
          {/* `<select>` can't host a `<span role="tooltip">` child, so the
              tip is anchored on an explicit wrapper span instead of going
              through the Tooltip component. */}
          <span className="tip tip-top inline-flex">
            <select
              value={rate}
              onChange={(e) => {
                const r = Number(e.currentTarget.value);
                setRate(r);
                if (videoRef.current) videoRef.current.playbackRate = r;
              }}
              className="t-primary text-meta bg-transparent rounded px-1 py-0.5"
              style={{ border: '1px solid rgba(255,255,255,0.05)' }}
              aria-label="Playback speed"
            >
              {SPEED_PRESETS.map((r) => (
                <option key={r} value={r}>
                  {r}×
                </option>
              ))}
            </select>
            <span role="tooltip" aria-hidden="true" className="tip-label">
              Playback speed (+/-)
            </span>
          </span>
          <Tooltip label="Picture-in-Picture (P)" side="top">
            <button
              onClick={() => {
                const v = videoRef.current;
                if (!v) return;
                if (document.pictureInPictureElement) {
                  document.exitPictureInPicture().catch(() => {});
                } else {
                  v.requestPictureInPicture?.().catch(() => {});
                }
              }}
              className="t-secondary hover:t-primary"
              aria-label="Picture-in-Picture"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor" />
              </svg>
            </button>
          </Tooltip>
          <Tooltip label="Fullscreen (F)" side="top">
            <button onClick={toggleFullscreen} className="t-secondary hover:t-primary" aria-label="Fullscreen">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6" />
              </svg>
            </button>
          </Tooltip>
          <Tooltip label="Close (Esc)" side="top">
            <button onClick={onClose} className="t-secondary hover:t-primary" aria-label="Close">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
};
