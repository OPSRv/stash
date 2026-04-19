import { useCallback, useEffect, useRef, useState } from 'react';

const YT_API_SRC = 'https://www.youtube.com/iframe_api';

/** Extract a YouTube video id from any common URL shape. Returns null when
 *  the input doesn't look like a YouTube URL. */
export const parseYouTubeId = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Bare 11-char id
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.replace(/^\//, '');
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      const v = url.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const m = url.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch {
    return null;
  }
  return null;
};

let apiReady: Promise<void> | null = null;
const ensureApi = (): Promise<void> => {
  if (apiReady) return apiReady;
  apiReady = new Promise<void>((resolve) => {
    const w = window as unknown as {
      YT?: { Player: unknown };
      onYouTubeIframeAPIReady?: () => void;
    };
    if (w.YT && w.YT.Player) {
      resolve();
      return;
    }
    w.onYouTubeIframeAPIReady = () => resolve();
    if (!document.querySelector(`script[src="${YT_API_SRC}"]`)) {
      const tag = document.createElement('script');
      tag.src = YT_API_SRC;
      document.head.appendChild(tag);
    }
  });
  return apiReady;
};

type YTPlayer = {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (s: number, allow: boolean) => void;
  setVolume: (v: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  loadVideoById: (id: string) => void;
  destroy: () => void;
};

type PlayerState = {
  ready: boolean;
  playing: boolean;
  duration: number;
  currentTime: number;
};

export const useYouTubePlayer = (containerId: string) => {
  const playerRef = useRef<YTPlayer | null>(null);
  const [state, setState] = useState<PlayerState>({
    ready: false,
    playing: false,
    duration: 0,
    currentTime: 0,
  });

  const load = useCallback(async (videoId: string) => {
    await ensureApi();
    const w = window as unknown as { YT: { Player: new (id: string, opts: unknown) => YTPlayer } };
    if (playerRef.current) {
      playerRef.current.loadVideoById(videoId);
      return;
    }
    playerRef.current = new w.YT.Player(containerId, {
      height: '1',
      width: '1',
      videoId,
      playerVars: { autoplay: 0, controls: 0, disablekb: 1, modestbranding: 1 },
      events: {
        onReady: () => {
          setState((s) => ({
            ...s,
            ready: true,
            duration: playerRef.current?.getDuration() ?? 0,
          }));
        },
        onStateChange: (e: { data: number }) => {
          // YT.PlayerState: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued.
          setState((s) => ({ ...s, playing: e.data === 1 }));
        },
      },
    });
  }, [containerId]);

  const play = useCallback(() => playerRef.current?.playVideo(), []);
  const pause = useCallback(() => playerRef.current?.pauseVideo(), []);
  const seek = useCallback((s: number) => playerRef.current?.seekTo(s, true), []);
  const setVolume = useCallback((v01: number) => {
    playerRef.current?.setVolume(Math.round(Math.max(0, Math.min(1, v01)) * 100));
  }, []);

  // Poll currentTime/duration only while a player exists.
  useEffect(() => {
    if (!state.ready) return;
    const id = window.setInterval(() => {
      const p = playerRef.current;
      if (!p) return;
      setState((s) => ({
        ...s,
        currentTime: p.getCurrentTime(),
        duration: p.getDuration(),
      }));
    }, 500);
    return () => window.clearInterval(id);
  }, [state.ready]);

  useEffect(() => {
    return () => {
      try {
        playerRef.current?.destroy();
      } catch {
        // ignored: destroy may throw on partially initialised players
      }
      playerRef.current = null;
    };
  }, []);

  return { state, load, play, pause, seek, setVolume };
};
