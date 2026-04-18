import { invoke } from '@tauri-apps/api/core';

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

export const start = (args: {
  url: string;
  title?: string | null;
  thumbnail?: string | null;
  format_id?: string | null;
  kind: 'video' | 'audio';
}): Promise<number> =>
  invoke('dl_start', {
    url: args.url,
    title: args.title ?? null,
    thumbnail: args.thumbnail ?? null,
    formatId: args.format_id ?? null,
    kind: args.kind,
  });

export const cancel = (id: number): Promise<void> => invoke('dl_cancel', { id });
export const list = (): Promise<DownloadJob[]> => invoke('dl_list');
export const deleteJob = (id: number): Promise<void> => invoke('dl_delete', { id });
export const clearCompleted = (): Promise<number> => invoke('dl_clear_completed');

export const setDownloadsDir = (path: string | null): Promise<void> =>
  invoke('dl_set_downloads_dir', { path });

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

export const formatBytes = (n: number | null | undefined): string => {
  if (!n || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

export const formatDuration = (sec: number | null | undefined): string => {
  if (!sec || sec < 0) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
};
