import { memo } from 'react';
import { IconButton } from '../../shared/ui/IconButton';
import { musicNext, musicPlayPause, musicPrev, type NowPlaying } from './api';

const PlayIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M8 5v14l11-7z" />
  </svg>
);

const PauseIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M6 5h4v14H6zm8 0h4v14h-4z" />
  </svg>
);

const PrevIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
  </svg>
);

const NextIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z" />
  </svg>
);

const CloseIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

interface Props {
  state: NowPlaying;
  onOpen: () => void;
  onClose: () => void;
  onOptimistic: (patch: Partial<NowPlaying>) => void;
}

/// Compact now-playing strip rendered by `PopupShell` whenever music is
/// playing and the user is *not* on the Music tab. Clicking the body jumps
/// to the Music tab; the transport buttons drive YT Music via the Rust
/// bridge so the user doesn't have to switch tabs to skip a song.
export const NowPlayingBar = memo(({ state, onOpen, onClose, onOptimistic }: Props) => {
  const title = state.title || 'YouTube Music';
  const subtitle = state.artist || (state.playing ? 'Playing' : 'Paused');

  // Optimistic update: flip the icon/label immediately so the bar feels
  // responsive even though the YT Music poller only reports back every 2s.
  // If the click lost the race (e.g. skip failed), the next poll overwrites
  // our guess with the real state.
  const wrap =
    (action: () => Promise<void>, patch: Partial<NowPlaying>) =>
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onOptimistic(patch);
      action().catch((err) => console.error('music control failed:', err));
    };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Now playing: ${title}${state.artist ? ` by ${state.artist}` : ''}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="mx-2 mt-2 px-2 py-1.5 rounded-lg flex items-center gap-2 cursor-pointer select-none"
      style={{
        background: 'rgba(var(--stash-accent-rgb), 0.08)',
        border: '1px solid rgba(var(--stash-accent-rgb), 0.22)',
      }}
    >
      <div className="w-7 h-7 rounded-md overflow-hidden shrink-0 bg-black/30 flex items-center justify-center">
        {state.artwork ? (
          <img src={state.artwork} alt="" className="w-full h-full object-cover" />
        ) : (
          <span className="t-tertiary text-meta">♪</span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="t-primary text-meta font-medium truncate">{title}</div>
        <div className="t-tertiary text-[11px] truncate">{subtitle}</div>
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        <IconButton onClick={wrap(musicPrev, { playing: true })} title="Previous">
          <PrevIcon />
        </IconButton>
        <IconButton
          onClick={wrap(musicPlayPause, { playing: !state.playing })}
          title={state.playing ? 'Pause' : 'Play'}
        >
          {state.playing ? <PauseIcon /> : <PlayIcon />}
        </IconButton>
        <IconButton onClick={wrap(musicNext, { playing: true })} title="Next">
          <NextIcon />
        </IconButton>
        <IconButton
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title="Dismiss"
          aria-label="Dismiss now playing"
        >
          <CloseIcon />
        </IconButton>
      </div>
    </div>
  );
});

NowPlayingBar.displayName = 'NowPlayingBar';
