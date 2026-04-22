import { useEffect, useState } from 'react';

import { accent } from '../../shared/theme/accent';
import { faviconUrlFor } from './webchatApi';

type Props = {
  /// URL of the service; hostname is extracted for Google's favicon API.
  url: string;
  /// Label used for the letter tile when the favicon can't load — first
  /// grapheme is uppercased.
  label: string;
  /// Rendered size in CSS pixels. The fetch always asks for a
  /// substantially larger source (see below) so the browser downscales a
  /// sharp image instead of rendering a blurry upscale.
  size: number;
  className?: string;
};

/// Google's s2 service rounds the `sz` query up to the closest size the
/// site actually provides (typically 16/32/64/128/256). At small display
/// sizes on retina, a 16→28px upscale reads as blurry, so we always ask
/// for 128 and let the browser do the downscale — crisp on both 1× and 2×
/// without a per-tab DPR calculation.
const FAVICON_SOURCE_SIZE = 128;

/// Favicon <img> with a built-in accent-coloured letter-tile fallback.
/// Guarantees every tab shows *some* visible icon — either the site's real
/// favicon or a branded coloured letter — instead of silently collapsing
/// to empty space when the fetch fails (offline, blocked host, etc.).
export const Favicon = ({ url, label, size, className }: Props) => {
  const src = faviconUrlFor(url, FAVICON_SOURCE_SIZE);
  const [failed, setFailed] = useState(false);

  // Reset the failed flag when the URL changes so a rename / pin-as-home
  // (which rewrites the service URL) gets a fresh attempt.
  useEffect(() => {
    setFailed(false);
  }, [src]);

  const fallback = !src || failed;
  const letter = label.trim().slice(0, 1).toUpperCase() || '?';

  if (fallback) {
    return (
      <span
        aria-hidden="true"
        className={`rounded-sm flex items-center justify-center font-semibold t-primary shrink-0 ${className ?? ''}`}
        style={{
          width: size,
          height: size,
          background: accent(0.25),
          fontSize: Math.max(9, Math.floor(size * 0.6)),
          lineHeight: 1,
        }}
      >
        {letter}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      className={`rounded-sm shrink-0 ${className ?? ''}`}
      onError={() => setFailed(true)}
    />
  );
};
