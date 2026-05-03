import { useEffect, useMemo, useState } from 'react';
import { notesVideoStreamUrl } from './api';

type Props = {
  /** Raw src from the markdown `![alt](src)` reference. */
  src: string;
  /** Alt text from the markdown — surfaces as a caption underneath. */
  alt?: string;
};

/** Inline video embed for markdown-referenced files. Resolves the path to
 *  a loopback `http://127.0.0.1:<port>/video?…` URL served by the notes
 *  media server with the right `video/*` MIME, so `<video>` plays
 *  natively (Range-request seeking included) without ferrying bytes over
 *  Tauri IPC. Tauri's `asset://` protocol is unreachable from
 *  react-markdown-rendered URLs (the URL-normalising transformer rewrites
 *  the scheme), so loopback HTTP is the only viable path. */
export const MarkdownVideoEmbed = ({ src, alt }: Props) => {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // react-markdown URL-encodes spaces → restore them before Rust compares
  // the path against the managed videos dir. Same decoding reasoning as
  // `MarkdownAudioPlayer`/`MarkdownImageEmbed`.
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
    notesVideoStreamUrl(decodedSrc)
      .then((u) => {
        if (cancelled) return;
        setUrl(u);
      })
      .catch((e) => {
        if (cancelled) return;
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
        data-testid="md-video-embed-error"
      >
        Can&rsquo;t load video: {alt || src}
      </span>
    );
  }

  return (
    <div className="my-2 flex flex-col gap-1.5" data-testid="md-video-embed">
      <video
        src={url ?? undefined}
        controls
        preload="metadata"
        className="rounded-md max-w-full h-auto"
        style={{ border: '1px solid var(--hairline)', background: 'black' }}
        data-md-src={decodedSrc}
      >
        <track kind="captions" />
      </video>
      {alt && <div className="t-tertiary text-meta">{alt}</div>}
    </div>
  );
};
