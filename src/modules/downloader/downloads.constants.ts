/// Hosts recognised by the video-URL autodetect paths (clipboard banner,
/// downloads shell auto-fill). Broader than `Platform::from_url` on the Rust
/// side because it also needs to filter *before* invoking yt-dlp.
export const SUPPORTED_VIDEO_URL =
  /https?:\/\/(www\.)?(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|twitter\.com|x\.com|reddit\.com|vimeo\.com|twitch\.tv|facebook\.com|fb\.watch)/i;

export const STATUS_LABELS = {
  pending: 'Queued',
  active: 'Downloading',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
} as const;

export const DETECT_SLOW_HINT_THRESHOLD_SEC = 8;
