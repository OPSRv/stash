import { memo } from 'react';

import { accent } from '../../shared/theme/accent';
import { IconButton } from '../../shared/ui/IconButton';
import { CloseIcon, PauseIcon, PlayIcon } from '../../shared/ui/icons';

import { faviconUrlFor, webchatTogglePlay, type WebchatNowPlaying } from './webchatApi';

interface Props {
  state: WebchatNowPlaying;
  serviceUrl?: string;
  onOpen: () => void;
  onClose: () => void;
  onOptimistic: (patch: Partial<WebchatNowPlaying>) => void;
}

/// Now-playing strip for a webchat service (YouTube video inside Gemini,
/// etc.). Renders on any tab except Web so the user can keep an eye on —
/// and pause — what's playing without switching back. Clicking the body
/// opens the Web tab and selects this service.
export const WebchatNowPlayingBar = memo(
  ({ state, serviceUrl, onOpen, onClose, onOptimistic }: Props) => {
    const title = state.title || state.service;
    const subtitle = state.artist || (state.playing ? 'Playing' : 'Paused');
    const favicon = serviceUrl ? faviconUrlFor(serviceUrl, 32) : null;

    const togglePlay = (e: React.MouseEvent) => {
      e.stopPropagation();
      onOptimistic({ playing: !state.playing });
      webchatTogglePlay(state.service).catch((err) =>
        console.error('webchat toggle play failed:', err),
      );
    };

    return (
      <div
        role="button"
        tabIndex={0}
        aria-label={`Playing in ${state.service}: ${title}`}
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
          ) : favicon ? (
            <img src={favicon} alt="" className="w-5 h-5" />
          ) : (
            <span className="t-tertiary text-meta">▶</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="t-primary text-meta font-medium truncate">{title}</div>
          <div className="t-tertiary text-meta truncate">{subtitle}</div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <IconButton
            onClick={togglePlay}
            title={state.playing ? 'Pause' : 'Play'}
          >
            {state.playing ? <PauseIcon /> : <PlayIcon />}
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
  },
);

WebchatNowPlayingBar.displayName = 'WebchatNowPlayingBar';
