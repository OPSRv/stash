import type { ReactNode } from 'react';
import { Card } from '../../shared/ui/Card';
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
  <Card
    padding="md"
    rounded="xl"
    className={`mx-4 mt-3 flex flex-wrap gap-3 items-center${muted ? ' opacity-85' : ''}`}
  >
    <div className="w-27.5 h-15.5 rounded-md overflow-hidden relative shrink-0 bg-black/60">
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
  </Card>
);
