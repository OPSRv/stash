import { useState } from 'react';
import { useLinkPreview } from '../clipboard/useLinkPreview';

type Props = { href: string };

/// Extract the YouTube video id from any of the canonical URL shapes — full
/// `watch?v=…`, short `youtu.be/…`, embed/shorts. Returns null when the URL
/// is not recognisable as YouTube so the caller falls back to the og card.
const youtubeId = (raw: string): string | null => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return /^[\w-]{11}$/.test(id) ? id : null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const v = url.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return v;
    const shortsMatch = url.pathname.match(/^\/(?:shorts|embed)\/([\w-]{11})/);
    if (shortsMatch) return shortsMatch[1];
  }
  return null;
};

const openExternal = async (href: string) => {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(href);
  } catch {
    window.open(href, '_blank', 'noopener,noreferrer');
  }
};

const YouTubeEmbed = ({ id, href }: { id: string; href: string }) => (
  // Cap width so the player doesn't dominate a narrow preview pane. 320px is
  // close to YouTube's own "small" embed width — readable, scannable, and
  // keeps surrounding text in view. The 16:9 box auto-scales the height.
  <div
    className="my-2 rounded-lg overflow-hidden border hair"
    style={{ aspectRatio: '16 / 9', maxWidth: 320, width: '100%' }}
  >
    <iframe
      src={`https://www.youtube-nocookie.com/embed/${id}`}
      title={`YouTube video ${id}`}
      allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
      allowFullScreen
      loading="lazy"
      referrerPolicy="strict-origin-when-cross-origin"
      className="w-full h-full block"
      data-href={href}
    />
  </div>
);

const PreviewCard = ({ href }: { href: string }) => {
  const preview = useLinkPreview(href);
  const [imageBroken, setImageBroken] = useState(false);
  let host = href;
  try {
    host = new URL(href).hostname;
  } catch {
    /* keep raw */
  }
  const showImage = preview?.image && !imageBroken;
  return (
    <button
      type="button"
      onClick={() => void openExternal(href)}
      className="my-2 w-full text-left rounded-lg overflow-hidden border hair flex gap-3 p-2 transition-colors hover:bg-white/[0.04] ring-focus"
      title={href}
    >
      {showImage ? (
        <img
          src={preview.image ?? undefined}
          alt=""
          onError={() => setImageBroken(true)}
          className="w-20 h-14 object-cover rounded-md shrink-0"
        />
      ) : (
        <div
          className="w-20 h-14 shrink-0 rounded-md flex items-center justify-center t-tertiary text-meta"
          style={{ background: 'rgba(var(--stash-accent-rgb), 0.12)' }}
          aria-hidden
        >
          {host.slice(0, 1).toUpperCase()}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="t-primary text-body font-medium truncate">
          {preview?.title || host}
        </div>
        {preview?.description && (
          <div className="t-tertiary text-meta line-clamp-2 mt-0.5">
            {preview.description}
          </div>
        )}
        <div className="t-tertiary text-[10px] truncate mt-0.5">
          {preview?.site_name || host}
        </div>
      </div>
    </button>
  );
};

/// Inline embed for a bare URL. YouTube becomes a player; anything else gets
/// an og-driven preview card. Falls back to a plain hostname tile when the
/// page exposes no metadata.
export const LinkEmbed = ({ href }: Props) => {
  const ytId = youtubeId(href);
  if (ytId) return <YouTubeEmbed id={ytId} href={href} />;
  return <PreviewCard href={href} />;
};
