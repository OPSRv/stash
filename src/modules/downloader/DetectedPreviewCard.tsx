import type { ReactNode } from 'react';
import { PlatformBadge } from './PlatformBadge';
import type { Platform } from './api';

interface DetectedPreviewCardProps {
  platform: Platform;
  title: string;
  uploader?: string | null;
  thumbnail?: string | null;
  overlayBadge?: ReactNode;
  footerText?: ReactNode;
  trailing?: ReactNode;
  muted?: boolean;
}

const cardStyle = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.05)',
} as const;

const mutedCardStyle = { ...cardStyle, opacity: 0.85 } as const;

const thumbStyle = { background: 'rgba(0,0,0,0.6)' } as const;

/// Shared visual for the "we know what this video is" row. Used both for the
/// instant oEmbed preview (muted, footer = spinner) and the full yt-dlp
/// preview (trailing = quality tabs + Download button). Trailing wraps onto
/// its own row when it can't fit beside the title — long quality lists no
/// longer crush the uploader name or clip the Download button.
export const DetectedPreviewCard = ({
  platform,
  title,
  uploader,
  thumbnail,
  overlayBadge,
  footerText,
  trailing,
  muted = false,
}: DetectedPreviewCardProps) => (
  <div
    className="mx-4 mt-3 rounded-xl p-3 flex flex-wrap gap-3 items-center"
    style={muted ? mutedCardStyle : cardStyle}
  >
    <div
      className="w-27.5 h-15.5 rounded-md overflow-hidden relative shrink-0"
      style={thumbStyle}
    >
      {thumbnail && (
        <img src={thumbnail} alt="" className="w-full h-full object-cover" />
      )}
      {overlayBadge}
    </div>
    <div className="flex-1 min-w-0 basis-[200px]">
      <div className="flex items-center gap-2 mb-0.5">
        <PlatformBadge platform={platform} />
        {uploader && (
          <span className="t-tertiary text-meta truncate">{uploader}</span>
        )}
      </div>
      <div className="t-primary text-body font-medium truncate">{title}</div>
      {footerText && <div className="t-tertiary text-meta truncate">{footerText}</div>}
    </div>
    {trailing && (
      <div className="flex items-center gap-2 flex-wrap basis-full md:basis-auto justify-end">
        {trailing}
      </div>
    )}
  </div>
);
