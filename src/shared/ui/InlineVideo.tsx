import { convertFileSrc } from '@tauri-apps/api/core';

type InlineVideoProps = {
  /// Absolute filesystem path OR URL. Absolute paths are normalised
  /// to `asset://` so WKWebView can actually fetch them.
  src: string;
  /// Optional caption shown under the player (Telegram caption or
  /// note-attachment original filename).
  caption?: string | null;
  /// Duration in seconds to render under the player. Only used when
  /// the source is a short video (voice/screen clip) — for long-form
  /// content we let the native controls surface the timeline instead.
  durationSec?: number | null;
  /// Width/height overrides. Default 320×200 — fits the 920 px popup
  /// without crowding the surrounding text.
  className?: string;
};

const normalise = (src: string): string => {
  if (/^[a-z]+:\/\//i.test(src) || src.startsWith('data:') || src.startsWith('blob:')) {
    return src;
  }
  if (src.startsWith('/')) return convertFileSrc(src);
  return src;
};

/// Inline video row with native HTML5 controls. The heavier full-
/// screen / speed / subtitles / position-memory modal lives at
/// `shared/ui/VideoPlayer` and is used by the Downloads module; this
/// is the lightweight variant for previewing clips in lists (inbox,
/// note attachments).
export const InlineVideo = ({
  src,
  caption,
  durationSec,
  className,
}: InlineVideoProps) => {
  const url = normalise(src);
  return (
    <div className="flex flex-col gap-2">
      <video
        src={url}
        controls
        preload="metadata"
        className={`rounded-lg border border-white/6 bg-black ${className ?? 'max-w-[320px] max-h-[200px]'}`}
      >
        <track kind="captions" />
      </video>
      {(caption || durationSec) && (
        <div className="flex items-center gap-2 text-[11px] text-white/50">
          {durationSec && (
            <span className="font-mono tabular-nums">{durationSec}s</span>
          )}
          {caption && <p className="text-white/80">{caption}</p>}
        </div>
      )}
    </div>
  );
};
