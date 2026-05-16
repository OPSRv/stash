/// Hosts recognised by the video-URL autodetect paths (clipboard banner,
/// downloads shell auto-fill). Broader than `Platform::from_url` on the Rust
/// side because it also needs to filter *before* invoking yt-dlp.
export const SUPPORTED_VIDEO_URL =
  /https?:\/\/([a-z0-9-]+\.)?(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|twitter\.com|x\.com|reddit\.com|vimeo\.com|twitch\.tv|facebook\.com|fb\.watch)/i;

/// Weaker check used to validate *manual* input: yt-dlp supports 1000+ sites,
/// so we only want to reject things that clearly aren't URLs (e.g. someone
/// pasted a plain word). `new URL()` is overly strict about protocol-less
/// hosts, so a regex for `http(s)://` is the right middle ground.
export const LIKELY_DOWNLOAD_URL = /^https?:\/\/\S+$/i;

export function isLikelyDownloadUrl(value: string): boolean {
  return LIKELY_DOWNLOAD_URL.test(value.trim());
}

export const STATUS_LABELS = {
  pending: 'Queued',
  active: 'Downloading',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
} as const;

export const DETECT_SLOW_HINT_THRESHOLD_SEC = 8;

/// Generic quality ladder shown the instant we know a URL is a video — lets
/// the user pick + start a download without waiting for the full yt-dlp
/// `--dump-json` round-trip (which can take 20+ s on YouTube). The runner
/// only needs `height` + `kind` to build its format selector, so the empty
/// `format_id` is fine — it's purely a UI-side key.
export const DEFAULT_QUALITY_OPTIONS = [
  { label: '1080p', format_id: 'auto-1080', kind: 'video', height: 1080 },
  { label: '720p', format_id: 'auto-720', kind: 'video', height: 720 },
  { label: '480p', format_id: 'auto-480', kind: 'video', height: 480 },
  { label: 'Audio', format_id: 'auto-audio', kind: 'audio', height: null },
] as const;
