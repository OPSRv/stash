/** One stored take, mirrors the Rust `Recording` (serde snake_case). */
export type Recording = {
  id: string;
  name: string;
  /** Absolute path on disk — feed to `media_stream_url` / `revealItemInDir`. */
  file_path: string;
  ext: string;
  duration_ms: number;
  size_bytes: number;
  device: string | null;
  favorite: boolean;
  /** Epoch milliseconds. */
  created_at: number;
};

/** Mime-type / file-extension pairs we try in order of preference.
 *
 *  **Order matters.** WKWebView (macOS, the production shell) records
 *  `audio/mp4`/AAC natively, which every audio stack — including the macOS
 *  media element behind the shared media server — plays without fuss. We keep
 *  WebM/Opus as the Chromium-dev fallback; the media server serves `.webm`
 *  too, so playback works in both. */
export const RECORD_CANDIDATES: { mime: string; ext: string }[] = [
  { mime: 'audio/mp4;codecs=mp4a.40.2', ext: 'm4a' },
  { mime: 'audio/mp4', ext: 'm4a' },
  { mime: 'audio/webm;codecs=opus', ext: 'webm' },
  { mime: 'audio/webm', ext: 'webm' },
  { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
];

export const pickRecordFormat = (): { mime: string; ext: string } => {
  const ctor = typeof MediaRecorder !== 'undefined' ? MediaRecorder : null;
  if (!ctor) return { mime: '', ext: 'webm' };
  for (const c of RECORD_CANDIDATES) {
    if (ctor.isTypeSupported?.(c.mime)) return c;
  }
  return { mime: '', ext: 'webm' };
};

/** Remembered input device, scoped to the recorder. */
export const MIC_PREF_KEY = 'stash:recorder:micDeviceId';

/** Remembered input gain (linear multiplier), scoped to the recorder. */
export const GAIN_PREF_KEY = 'stash:recorder:inputGain';

/** Input-gain bounds. `1` is unity (mic passed through untouched); below
 *  attenuates, above boosts. Capped at 4× so a genuinely quiet mic can be
 *  brought up to a usable level — high enough to clip a hot input, so the
 *  upper half of the range is a "use with care" zone. */
export const GAIN_MIN = 0;
export const GAIN_MAX = 4;
export const GAIN_DEFAULT = 1;
