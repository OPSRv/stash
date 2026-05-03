import { useEffect, useMemo, useState } from 'react';
import { Lightbox } from '../../shared/ui/Lightbox';
import { notesImageStreamUrl } from './api';

type Props = {
  /** Raw src from the markdown `![alt](src)` reference. */
  src: string;
  /** Alt text from the markdown, used verbatim for the `<img alt>`. */
  alt?: string;
};

/** Inline image embed for markdown-referenced files. Resolves the path to
 *  a loopback `http://127.0.0.1:<port>/image?...` URL served by the notes
 *  media server — the browser streams bytes directly, so the renderer
 *  never has to materialise a multi-MB blob via IPC just to display the
 *  picture. Tauri's `asset://` protocol is unreachable from
 *  react-markdown-rendered `<img src>` (URL-normalising transformer
 *  rewrites the scheme), so loopback HTTP is the only viable path. */
export const MarkdownImageEmbed = ({ src, alt }: Props) => {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);

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
    setUrl(null);
    setError(null);
    notesImageStreamUrl(decodedSrc)
      .then((u) => {
        if (cancelled) return;
        setUrl(u);
      })
      .catch((e) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error('[MarkdownImageEmbed] resolve stream url failed', { src, decodedSrc, error: e });
        setError(String(e));
      });
    return () => {
      cancelled = true;
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
    <>
      <img
        src={url ?? undefined}
        alt={alt ?? ''}
        onClick={() => url && setZoomed(true)}
        className="my-2 rounded-md max-w-full h-auto cursor-zoom-in"
        style={{ border: '1px solid rgba(255, 255, 255, 0.08)' }}
        data-testid="md-image-embed"
        data-md-src={decodedSrc}
      />
      {zoomed && url && (
        <Lightbox
          src={url}
          alt={alt}
          path={decodedSrc}
          onClose={() => setZoomed(false)}
        />
      )}
    </>
  );
};
