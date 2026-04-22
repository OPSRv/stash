import { useEffect, useState } from 'react';

import { faviconUrlFor } from './webchatApi';

type Props = {
  /// URL of the service; hostname is extracted for Google's favicon API.
  url: string;
  /// Label used for the letter tile when the favicon can't load — first
  /// grapheme is uppercased.
  label: string;
  /// Rendered size in CSS pixels. We always request at least 2× from the
  /// favicon service so the tile stays crisp on retina.
  size: number;
  className?: string;
};

/// Favicon <img> with a built-in accent-coloured letter-tile fallback.
/// Guarantees every tab shows *some* visible icon — either the site's real
/// favicon or a branded coloured letter — instead of silently collapsing
/// to empty space when the fetch fails (offline, blocked host, etc.).
export const Favicon = ({ url, label, size, className }: Props) => {
  const requested = Math.max(32, size * 2);
  const src = faviconUrlFor(url, requested);
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
          background: 'rgba(var(--stash-accent-rgb), 0.25)',
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
