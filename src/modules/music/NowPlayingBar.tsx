import { memo } from 'react';
import { accent } from '../../shared/theme/accent';
import { IconButton } from '../../shared/ui/IconButton';
import { CloseIcon, NextIcon, PauseIcon, PlayIcon, PrevIcon } from '../../shared/ui/icons';
import { musicNext, musicPlayPause, musicPrev, type NowPlaying } from './api';

interface NowPlayingBarProps {
  state: NowPlaying;
  onOpen: () => void;
  onClose: () => void;
  onOptimistic: (patch: Partial<NowPlaying>) => void;
}

/// Compact now-playing strip rendered by `PopupShell` whenever music is
/// playing and the user is *not* on the Music tab. Clicking the body jumps
/// to the Music tab; the transport buttons drive YT Music via the Rust
/// bridge so the user doesn't have to switch tabs to skip a song.
export const NowPlayingBar = memo(({ state, onOpen, onClose, onOptimistic }: NowPlayingBarProps) => {
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
      className="px-2 py-1.5 rounded-lg flex items-center gap-2 cursor-pointer select-none"
      style={{
        background: accent(0.08),
        border: `1px solid ${accent(0.22)}`,
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
