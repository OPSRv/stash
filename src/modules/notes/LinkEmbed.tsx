import { useMemo, useState } from 'react';
import { accent } from '../../shared/theme/accent';
import { useLinkPreview } from '../clipboard/useLinkPreview';

type Props = { href: string };

const hostOf = (raw: string): string => {
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return raw;
  }
};

/// Google's s2 favicon service — same fallback already used in `LinkRow`.
/// 64 px gives a sharp icon at the 16 px we render on this card.
const faviconUrl = (host: string): string =>
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;

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

/// Telegram-style link preview: accent rule on the left, a header row with
/// favicon + site name, the page title and description, then the OG image at
/// full width underneath. Falls back gracefully when any field is missing —
/// a bare hostname tile when the page exposes nothing usable.
const PreviewCard = ({ href }: { href: string }) => {
  const preview = useLinkPreview(href);
  const [ogBroken, setOgBroken] = useState(false);
  const [iconBroken, setIconBroken] = useState(false);
  const host = useMemo(() => hostOf(href), [href]);
  const showImage = !!preview?.image && !ogBroken;
  const showIcon = !iconBroken;
  const siteLabel = preview?.site_name || host;
  const title = preview?.title || host;
  return (
    <button
      type="button"
      onClick={() => void openExternal(href)}
      className="my-2 w-full text-left rounded-[var(--r-lg)] overflow-hidden border hair flex transition-colors hover:[background:var(--bg-hover)] ring-focus"
      title={href}
    >
      {/* Telegram-style accent rail — visually anchors the card and signals
          it's a link block, not just an image with text. */}
      <div
        aria-hidden
        className="shrink-0 w-[3px]"
        style={{ background: 'rgb(var(--stash-accent-rgb))' }}
      />
      <div className="flex-1 min-w-0 flex flex-col gap-1 p-2.5">
        <div className="flex items-center gap-1.5 min-w-0">
          {showIcon ? (
            <img
              src={faviconUrl(host)}
              alt=""
              onError={() => setIconBroken(true)}
              className="w-4 h-4 shrink-0 rounded-[3px]"
            />
          ) : (
            <div
              aria-hidden
              className="w-4 h-4 shrink-0 rounded-[3px] flex items-center justify-center t-tertiary text-[9px] font-semibold"
              style={{ background: accent(0.18) }}
            >
              {host.slice(0, 1).toUpperCase()}
            </div>
          )}
          <span className="t-tertiary text-meta truncate">{siteLabel}</span>
        </div>
        <div className="t-primary text-body font-medium leading-snug line-clamp-2">
          {title}
        </div>
        {preview?.description && (
          <div className="t-tertiary text-meta leading-snug line-clamp-2">
            {preview.description}
          </div>
        )}
        {showImage && (
          <img
            src={preview?.image ?? undefined}
            alt=""
            onError={() => setOgBroken(true)}
            className="mt-1 w-full h-44 object-cover rounded-md"
            loading="lazy"
          />
        )}
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
