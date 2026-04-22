import { useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';

import { Lightbox } from './Lightbox';

const basename = (p: string) => p.replace(/^.*[\\/]/, '');

const formatBytes = (n: number | null | undefined) => {
  if (!n || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
};

type PhotoItemProps = {
  filePath: string;
  caption: string | null;
};

/// Thumbnail-first photo row. Click → fullscreen lightbox.
export const PhotoItem = ({ filePath, caption }: PhotoItemProps) => {
  const [open, setOpen] = useState(false);
  const url = convertFileSrc(filePath);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open image"
        className="w-fit rounded-lg overflow-hidden border border-white/6 hover:border-white/15 transition-colors"
      >
        <img
          src={url}
          alt={caption ?? basename(filePath)}
          className="max-w-[220px] max-h-[160px] object-cover block"
          loading="lazy"
        />
      </button>
      {caption && (
        <p className="text-[13px] leading-[18px] text-white/80 whitespace-pre-wrap">
          {caption}
        </p>
      )}
      {open && <Lightbox src={url} alt={caption ?? undefined} onClose={() => setOpen(false)} />}
    </div>
  );
};

type VideoItemProps = {
  filePath: string;
  caption: string | null;
  durationSec: number | null;
};

/// Inline HTML5 video. Default browser controls keep UA-consistent
/// timeline/volume handling without reimplementing them here.
export const VideoItem = ({ filePath, caption, durationSec }: VideoItemProps) => {
  const url = convertFileSrc(filePath);
  return (
    <div className="flex flex-col gap-2">
      <video
        src={url}
        controls
        preload="metadata"
        className="max-w-[320px] max-h-[200px] rounded-lg border border-white/6 bg-black"
      >
        <track kind="captions" />
      </video>
      {(caption || durationSec) && (
        <div className="flex items-center gap-2 text-[11px] text-white/50">
          {durationSec && <span className="font-mono tabular-nums">{durationSec}s</span>}
          {caption && <p className="text-white/80">{caption}</p>}
        </div>
      )}
    </div>
  );
};

type DocumentItemProps = {
  filePath: string;
  mimeType: string | null;
  caption: string | null;
};

/// Generic file row — no preview, just an icon, filename, and type hint.
export const DocumentItem = ({ filePath, mimeType, caption }: DocumentItemProps) => {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div
          className="w-9 h-9 rounded-md flex items-center justify-center shrink-0"
          style={{
            backgroundColor: 'rgba(var(--stash-accent-rgb), 0.10)',
            color: 'rgb(var(--stash-accent-rgb))',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-white/92 truncate">{basename(filePath)}</div>
          {mimeType && (
            <div className="text-[11px] text-white/45 truncate font-mono">{mimeType}</div>
          )}
        </div>
      </div>
      {caption && (
        <p className="text-[13px] leading-[18px] text-white/80 whitespace-pre-wrap">
          {caption}
        </p>
      )}
    </div>
  );
};

type TextItemProps = {
  content: string;
};

export const TextItem = ({ content }: TextItemProps) => (
  <p className="text-[13px] leading-[18px] text-white/90 whitespace-pre-wrap">
    {content}
  </p>
);

export { formatBytes };
