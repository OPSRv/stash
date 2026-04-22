import { FileChip, formatBytes } from '../../../../shared/ui/FileChip';
import { ImageThumbnail } from '../../../../shared/ui/ImageThumbnail';
import { InlineVideo } from '../../../../shared/ui/InlineVideo';

/// Telegram-inbox body renderers. Each kind delegates to a shared
/// `shared/ui/*` component so the same file type looks identical in
/// the inbox, in notes attachments, and anywhere else.

const basename = (p: string) => p.replace(/^.*[\\/]/, '');

type PhotoItemProps = {
  filePath: string;
  caption: string | null;
};

export const PhotoItem = ({ filePath, caption }: PhotoItemProps) => (
  <ImageThumbnail
    src={filePath}
    alt={caption ?? basename(filePath)}
    caption={caption}
  />
);

type VideoItemProps = {
  filePath: string;
  caption: string | null;
  durationSec: number | null;
};

export const VideoItem = ({ filePath, caption, durationSec }: VideoItemProps) => (
  <InlineVideo src={filePath} caption={caption} durationSec={durationSec} />
);

type DocumentItemProps = {
  filePath: string;
  mimeType: string | null;
  caption: string | null;
};

export const DocumentItem = ({ filePath, mimeType, caption }: DocumentItemProps) => (
  <FileChip name={basename(filePath)} mimeType={mimeType} caption={caption} />
);

type TextItemProps = {
  content: string;
};

export const TextItem = ({ content }: TextItemProps) => (
  <p className="text-[13px] leading-[18px] text-white/90 whitespace-pre-wrap">
    {content}
  </p>
);

// Re-export so existing callers of `formatBytes` from this file keep
// working — but new code should import directly from `shared/ui`.
export { formatBytes };
