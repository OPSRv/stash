import { invoke } from '@tauri-apps/api/core';
import { formatBytes as fmtBytes } from '../../shared/format/bytes';
import { formatDuration as fmtDuration } from '../../shared/format/duration';

export type Platform =
  | 'youtube'
  | 'instagram'
  | 'tiktok'
  | 'twitter'
  | 'reddit'
  | 'vimeo'
  | 'twitch'
  | 'facebook'
  | 'generic';

export type QualityOption = {
  label: string;
  format_id: string;
  kind: 'video' | 'audio';
  height?: number | null;
  est_size?: number | null;
};

export type VideoInfo = {
  id: string;
  title: string;
  uploader: string | null;
  thumbnail: string | null;
  duration: number | null;
  webpage_url: string | null;
  formats: unknown[];
};

export type DetectedVideo = {
  platform: Platform;
  info: VideoInfo;
  qualities: QualityOption[];
};

export type DownloadJob = {
  id: number;
  url: string;
  platform: string;
  title: string | null;
  thumbnail_url: string | null;
  format_id: string | null;
  target_path: string | null;
  status: 'pending' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  bytes_total: number | null;
  bytes_done: number | null;
  error: string | null;
  created_at: number;
  completed_at: number | null;
};

export const detect = (url: string): Promise<DetectedVideo> => invoke('dl_detect', { url });

export type QuickDetect = {
  platform: Platform;
  preview: { title: string; uploader: string | null; thumbnail: string | null };
};

export const detectQuick = (url: string): Promise<QuickDetect | null> =>
  invoke('dl_detect_quick', { url });

export const start = (args: {
  url: string;
  title?: string | null;
  thumbnail?: string | null;
  format_id?: string | null;
  height?: number | null;
  kind: 'video' | 'audio';
}): Promise<number> =>
  invoke('dl_start', {
    url: args.url,
    title: args.title ?? null,
    thumbnail: args.thumbnail ?? null,
    formatId: args.format_id ?? null,
    height: args.height ?? null,
    kind: args.kind,
  });

export const cancel = (id: number): Promise<void> => invoke('dl_cancel', { id });
export const list = (): Promise<DownloadJob[]> => invoke('dl_list');
export const deleteJob = (id: number, purgeFile = false): Promise<void> =>
  invoke('dl_delete', { id, purgeFile });
/** Fetch subtitle text for a completed job. Runs yt-dlp with `--skip-download`
 *  and parses the resulting VTT into plain text; the caller decides what to do
 *  with it (usually hand it off to notesCreate). */
export const extractSubtitles = (id: number, langs?: string[]): Promise<string> =>
  invoke('dl_extract_subtitles', { id, langs: langs ?? null });
export const clearCompleted = (): Promise<number> => invoke('dl_clear_completed');
export const pause = (id: number): Promise<void> => invoke('dl_pause', { id });
export const resume = (id: number): Promise<void> => invoke('dl_resume', { id });
export const retry = (id: number): Promise<void> => invoke('dl_retry', { id });

export type YtDlpVersionInfo = {
  installed: string | null;
  latest: string | null;
  path: string | null;
};
export const ytDlpVersion = (): Promise<YtDlpVersionInfo> => invoke('dl_ytdlp_version');
export const updateYtDlp = (): Promise<string> => invoke('dl_update_binary');
export const purgeCookies = (): Promise<void> => invoke('dl_purge_cookies');

export const setDownloadsDir = (path: string | null): Promise<void> =>
  invoke('dl_set_downloads_dir', { path });

export const setCookiesBrowser = (browser: string | null): Promise<void> =>
  invoke('dl_set_cookies_browser', { browser });

export const setMaxParallel = (value: number): Promise<void> =>
  invoke('dl_set_max_parallel', { value });

export const setRateLimit = (value: string | null): Promise<void> =>
  invoke('dl_set_rate_limit', { value });

export const pruneHistory = (olderThanDays: number): Promise<number> =>
  invoke('dl_prune_history', { olderThanDays });

export const platformBadge = (p: Platform | string): { label: string; bg: string; fg: string } => {
  const known: Record<string, { label: string; bg: string; fg: string }> = {
    youtube: { label: 'YOUTUBE', bg: 'rgba(235,72,72,0.16)', fg: '#FF6B6B' },
    instagram: { label: 'INSTAGRAM', bg: 'rgba(229,68,138,0.14)', fg: '#E5448A' },
    tiktok: { label: 'TIKTOK', bg: 'rgba(255,255,255,0.10)', fg: 'rgba(255,255,255,0.85)' },
    twitter: { label: 'X', bg: 'rgba(29,155,240,0.14)', fg: '#4DB2FF' },
    reddit: { label: 'REDDIT', bg: 'rgba(255,69,58,0.14)', fg: '#FF6B6B' },
    vimeo: { label: 'VIMEO', bg: 'rgba(26,183,234,0.14)', fg: '#1AB7EA' },
    twitch: { label: 'TWITCH', bg: 'rgba(145,71,255,0.14)', fg: '#9147FF' },
    facebook: { label: 'FACEBOOK', bg: 'rgba(24,119,242,0.14)', fg: '#2D88FF' },
    generic: { label: 'LINK', bg: 'rgba(255,255,255,0.06)', fg: 'rgba(255,255,255,0.7)' },
  };
  return known[p as string] ?? known.generic;
};

export const formatBytes = (n: number | null | undefined): string =>
  fmtBytes(n, { empty: '' });

export const formatDuration = (sec: number | null | undefined): string =>
  fmtDuration(sec, { empty: '' });
