import { useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Button } from '../../shared/ui/Button';

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  const ms = Math.floor((s - Math.floor(s)) * 100);
  return `${m.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}.${ms
    .toString()
    .padStart(2, '0')}`;
};

export const TrimDialog = ({
  source,
  onClose,
  onRun,
  onTrimmed,
}: {
  source: string;
  onClose: () => void;
  onRun: (start: number, end: number) => Promise<string>;
  onTrimmed: (path: string) => void;
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onMetadata = () => {
    const v = videoRef.current;
    if (!v) return;
    setDuration(v.duration);
    setEnd(v.duration);
  };

  const seek = (t: number) => {
    const v = videoRef.current;
    if (v && Number.isFinite(t)) v.currentTime = t;
  };

  const confirm = async () => {
    if (end <= start) {
      setError('End must be after start');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const out = await onRun(start, end);
      onTrimmed(out);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)' }}
      onClick={onClose}
    >
      <div
        className="rounded-xl p-4 w-full max-w-[560px]"
        style={{
          background: 'rgba(30,30,30,0.95)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="t-primary text-heading font-semibold">Trim</div>
          <button
            onClick={onClose}
            className="t-tertiary hover:t-primary text-meta px-2 py-1"
          >
            ×
          </button>
        </div>

        <video
          ref={videoRef}
          src={convertFileSrc(source)}
          className="w-full rounded-lg bg-black mb-3"
          controls
          preload="metadata"
          onLoadedMetadata={onMetadata}
        />

        <div className="space-y-3">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="t-secondary text-meta">Start · {fmt(start)}</span>
              <button
                onClick={() => {
                  const v = videoRef.current;
                  if (v) setStart(v.currentTime);
                }}
                className="t-primary text-meta px-2 py-0.5 rounded"
                style={{ background: 'rgba(255,255,255,0.06)' }}
              >
                Set from playhead
              </button>
            </div>
            <input
              type="range"
              min={0}
              max={Math.max(duration, 0.1)}
              step={0.01}
              value={start}
              onChange={(e) => {
                const v = Number(e.currentTarget.value);
                setStart(v);
                seek(v);
              }}
              className="w-full"
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="t-secondary text-meta">End · {fmt(end)}</span>
              <button
                onClick={() => {
                  const v = videoRef.current;
                  if (v) setEnd(v.currentTime);
                }}
                className="t-primary text-meta px-2 py-0.5 rounded"
                style={{ background: 'rgba(255,255,255,0.06)' }}
              >
                Set from playhead
              </button>
            </div>
            <input
              type="range"
              min={0}
              max={Math.max(duration, 0.1)}
              step={0.01}
              value={end}
              onChange={(e) => {
                const v = Number(e.currentTarget.value);
                setEnd(v);
                seek(v);
              }}
              className="w-full"
            />
          </div>

          <div className="t-tertiary text-meta">
            Clip length: {fmt(Math.max(0, end - start))}
          </div>
          {error && (
            <div
              className="rounded-md px-3 py-2 text-meta"
              style={{ background: 'rgba(235,72,72,0.08)', color: '#FF9B9B' }}
            >
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button variant="soft" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="solid"
              tone="accent"
              disabled={end <= start}
              loading={busy}
              onClick={confirm}
            >
              {busy ? 'Trimming…' : 'Save trimmed copy'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
