import { useEffect, useMemo, useState } from 'react';
import { notesReadImageByPath } from './api';

/** Map a path's extension to a MIME type the browser needs to decode the
 *  blob. Most browsers sniff regardless, but an explicit type avoids an
 *  early `onerror` on edge cases like HEIC on non-Safari WebViews. */
const mimeFor = (path: string): string => {
  const ext = path.split(/[?#]/)[0].split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    case 'bmp':
      return 'image/bmp';
    case 'heic':
    case 'heif':
      return 'image/heic';
    default:
      return 'application/octet-stream';
  }
};

type Props = {
  /** Raw src from the markdown `![alt](src)` reference. */
  src: string;
  /** Alt text from the markdown, used verbatim for the `<img alt>`. */
  alt?: string;
};

/** Inline image embed for markdown-referenced files. Same bytes-to-blob
 *  round-trip as the audio player — WebKit can't fetch `asset://` URLs
 *  that land in the editor via react-markdown's URL-normalising
 *  transformer, so we skip the asset protocol entirely. */
export const MarkdownImageEmbed = ({ src, alt }: Props) => {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // react-markdown URL-encodes spaces → restore them before Rust compares
  // the path against the managed images dir. Same decoding reasoning as
  // `MarkdownAudioPlayer`.
  const decodedSrc = useMemo(() => {
    try {
      return decodeURI(src);
    } catch {
      return src;
    }
  }, [src]);

  useEffect(() => {
    let cancelled = false;
    let revoke: string | null = null;
    setUrl(null);
    setError(null);
    notesReadImageByPath(decodedSrc)
      .then((bytes) => {
        if (cancelled) return;
        if (!bytes || bytes.byteLength === 0) {
          setError('Empty image file');
          return;
        }
        const blob = new Blob([new Uint8Array(bytes)], { type: mimeFor(src) });
        const u = URL.createObjectURL(blob);
        revoke = u;
        setUrl(u);
      })
      .catch((e) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error('[MarkdownImageEmbed] read bytes failed', { src, decodedSrc, error: e });
        setError(String(e));
      });
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [decodedSrc, src]);

  if (error) {
    return (
      <span
        className="inline-block text-meta my-2 px-2 py-1 rounded"
        style={{ color: 'rgba(239, 68, 68, 0.95)', background: 'rgba(239, 68, 68, 0.08)' }}
        title={`${error}\n\nsrc: ${src}`}
        data-testid="md-image-embed-error"
      >
        Can&rsquo;t load image: {alt || src}
      </span>
    );
  }

  return (
    <img
      src={url ?? undefined}
      alt={alt ?? ''}
      className="my-2 rounded-md max-w-full h-auto"
      style={{ border: '1px solid rgba(255, 255, 255, 0.08)' }}
      data-testid="md-image-embed"
    />
  );
};
