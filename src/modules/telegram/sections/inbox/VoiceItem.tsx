import { useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';

type VoiceItemProps = {
  filePath: string;
  durationSec: number | null;
  transcript: string | null;
  /// When true, the backend is currently running Whisper on this file.
  /// Surfaces a shimmer banner under the player so the user knows a
  /// transcript is on the way.
  transcribing: boolean;
  /// When true, Whisper rejected the audio — no transcript is coming.
  /// Rendered as a subdued warning; the audio itself still plays.
  failed?: boolean;
  /// Retry the transcription. Wired only when the backend supports it.
  onRetry?: () => void;
  /// Persist a user-edited transcript. When omitted the block becomes
  /// read-only (e.g. tests or contexts where editing isn't wired yet).
  onEditTranscript?: (next: string) => Promise<void> | void;
};

const fmt = (s: number) => {
  const t = Math.max(0, Math.round(s));
  const m = Math.floor(t / 60);
  const ss = t % 60;
  return `${m}:${ss.toString().padStart(2, '0')}`;
};

/// Inline voice-message row with a custom transport. We avoid the
/// native `<audio controls>` because its dark-mode treatment is
/// inconsistent across WebKit versions and the bar eats too much
/// vertical space.
export const VoiceItem = ({
  filePath,
  durationSec,
  transcript,
  transcribing,
  failed,
  onRetry,
  onEditTranscript,
}: VoiceItemProps) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(durationSec ?? 0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(transcript ?? '');
  useEffect(() => {
    // Keep the draft in sync when an external update (retry, new
    // Whisper landing) replaces the transcript while the row is idle.
    if (!editing) setDraft(transcript ?? '');
  }, [transcript, editing]);

  // `durationSec` from Telegram is the authoritative length; the audio
  // element may report a slightly different number once metadata loads.
  useEffect(() => {
    if (durationSec && durationSec > 0) setDuration(durationSec);
  }, [durationSec]);

  const onTimeUpdate = () => {
    const a = audioRef.current;
    if (!a) return;
    setCurrent(a.currentTime);
  };
  const onLoadedMeta = () => {
    const a = audioRef.current;
    if (!a) return;
    if (!durationSec || durationSec <= 0) setDuration(a.duration);
  };
  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      void a.play();
      setPlaying(true);
    } else {
      a.pause();
      setPlaying(false);
    }
  };
  const onEnded = () => {
    setPlaying(false);
    setCurrent(0);
  };
  const onSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current;
    if (!a || duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    a.currentTime = pct * duration;
    setCurrent(a.currentTime);
  };

  const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? 'Pause voice message' : 'Play voice message'}
          className="w-8 h-8 rounded-full bg-[rgba(var(--stash-accent-rgb),0.18)] hover:bg-[rgba(var(--stash-accent-rgb),0.28)] text-white flex items-center justify-center transition-colors shrink-0"
          style={{ color: 'rgb(var(--stash-accent-rgb))' }}
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
          aria-label="Voice progress"
          aria-valuemin={0}
          aria-valuemax={Math.max(1, Math.round(duration))}
          aria-valuenow={Math.round(current)}
          onClick={onSeek}
          className="flex-1 h-1.5 rounded-full bg-white/8 overflow-hidden cursor-pointer"
        >
          <div
            className="h-full rounded-full transition-[width]"
            style={{
              width: `${pct}%`,
              backgroundColor: 'rgb(var(--stash-accent-rgb))',
            }}
          />
        </div>
        <span className="text-[11px] font-mono text-white/50 tabular-nums shrink-0">
          {fmt(current)} / {fmt(duration)}
        </span>
        <audio
          ref={audioRef}
          src={convertFileSrc(filePath)}
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={onLoadedMeta}
          onEnded={onEnded}
          preload="metadata"
        />
      </div>
      {transcribing && (
        <div
          className="text-[11px] text-white/60 flex items-center gap-2"
          role="status"
          aria-live="polite"
        >
          <span className="w-3 h-3 rounded-full border border-white/30 border-t-transparent animate-spin" aria-hidden />
          Транскрибую…
        </div>
      )}
      {!transcribing && failed && !transcript && (
        <div className="flex items-center gap-2 text-[11px] text-amber-300/80">
          <span>⚠ Не вдалося транскрибувати</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="text-amber-200/90 hover:text-amber-100 underline decoration-dotted underline-offset-2"
            >
              Спробувати ще раз
            </button>
          )}
        </div>
      )}
      {transcript && !editing && (
        <div className="flex items-start gap-2 group/transcript">
          <p
            className="flex-1 text-[13px] leading-[18px] text-white/90 whitespace-pre-wrap bg-white/3 rounded-md px-3 py-2 border border-white/5"
            onDoubleClick={() => onEditTranscript && setEditing(true)}
            title={onEditTranscript ? 'Double-click to edit' : undefined}
          >
            {transcript}
          </p>
          {onEditTranscript && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label="Edit transcript"
              className="opacity-0 group-hover/transcript:opacity-100 focus:opacity-100 mt-1 text-[11px] text-white/50 hover:text-white/90 transition-opacity"
            >
              edit
            </button>
          )}
        </div>
      )}
      {transcript && editing && onEditTranscript && (
        <div className="flex flex-col gap-2">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="text-[13px] leading-[18px] text-white/90 bg-white/3 rounded-md px-3 py-2 border border-white/10 focus:border-[rgba(var(--stash-accent-rgb),0.4)] outline-none min-h-[72px] font-sans resize-y"
            aria-label="Edit transcript"
          />
          <div className="flex gap-2">
            <button
              type="button"
              className="text-[11px] px-2 py-1 rounded bg-[rgba(var(--stash-accent-rgb),0.15)] hover:bg-[rgba(var(--stash-accent-rgb),0.25)] text-[rgb(var(--stash-accent-rgb))]"
              onClick={async () => {
                await onEditTranscript(draft);
                setEditing(false);
              }}
            >
              Save
            </button>
            <button
              type="button"
              className="text-[11px] px-2 py-1 rounded text-white/60 hover:text-white/90"
              onClick={() => {
                setDraft(transcript);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
