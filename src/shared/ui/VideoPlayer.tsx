import { useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';

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

export const VideoPlayer = ({ src, onClose }: VideoPlayerProps) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setProgress(v.currentTime);
    const onLoad = () => setDuration(v.duration);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('loadedmetadata', onLoad);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('loadedmetadata', onLoad);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
    };
  }, []);

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
        onClose();
      } else if (e.key === 'f' || e.key === 'F') {
        if (document.fullscreenElement) document.exitFullscreen();
        else v.requestFullscreen();
      } else if (e.key === 'm' || e.key === 'M') {
        v.muted = !v.muted;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
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
        <video
          ref={videoRef}
          src={convertFileSrc(src)}
          className="max-h-[80vh] rounded-lg"
          autoPlay
          onClick={togglePlay}
        />

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
          <button onClick={toggleFullscreen} className="t-secondary hover:t-primary" title="Fullscreen (F)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6" />
            </svg>
          </button>
          <button onClick={onClose} className="t-secondary hover:t-primary" title="Close (Esc)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};
