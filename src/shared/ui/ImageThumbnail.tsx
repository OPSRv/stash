import { useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';

import { Lightbox } from './Lightbox';
import { BrokenImageIcon } from './icons';

type ImageThumbnailProps = {
  /// Absolute filesystem path OR a URL (asset://, file://, http, blob:).
  /// Absolute paths are routed through `convertFileSrc` so WKWebView's
  /// asset protocol picks them up.
  src: string;
  /// Accessible label. Falls back to a generic "image" when absent.
  alt?: string;
  /// Caption rendered under the thumbnail. Typically the Telegram
  /// caption or the note-attachment original filename.
  caption?: string | null;
  /// Tailwind class overrides for the clickable wrapper — callers
  /// pin thumbnail dimensions here. Defaults to a 220×160 tile.
  className?: string;
};

const normalise = (src: string): string => {
  if (/^[a-z]+:\/\//i.test(src) || src.startsWith('data:') || src.startsWith('blob:')) {
    return src;
  }
  if (src.startsWith('/')) return convertFileSrc(src);
  return src;
};

/// Thumbnail-first image row. Click opens the shared `Lightbox` with
/// click-outside / Esc to dismiss. Replaces the ad-hoc "href=img"
/// patterns that popped up in both the Telegram inbox and the note
/// attachments rail.
export const ImageThumbnail = ({
  src,
  alt,
  caption,
  className,
}: ImageThumbnailProps) => {
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  const url = normalise(src);
  const label = alt ?? 'image';
  return (
    <div className="flex flex-col gap-2">
      {broken ? (
        <div
          role="img"
          aria-label={`${label} (failed to load)`}
          className={`w-[220px] h-[160px] flex flex-col items-center justify-center gap-2 rounded-lg border [border-color:var(--hairline)] [background:var(--bg-hover)] text-white/40 ${className ?? ''}`}
        >
          <BrokenImageIcon size={32} />
          <span className="text-[12px] leading-none">image unavailable</span>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Open ${label}`}
          className={`w-fit rounded-lg overflow-hidden border [border-color:var(--hairline)] hover:[border-color:var(--hairline-strong)] transition-colors ${className ?? ''}`}
        >
          <img
            src={url}
            alt={label}
            className="max-w-[220px] max-h-[160px] object-cover block"
            loading="lazy"
            onError={() => setBroken(true)}
          />
        </button>
      )}
      {caption && (
        <p className="text-[13px] leading-[18px] text-white/80 whitespace-pre-wrap">
          {caption}
        </p>
      )}
      {open && !broken && (
        <Lightbox
          src={url}
          alt={label}
          path={src.startsWith('/') ? src : undefined}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
};
