import { AudioPlayer } from '../../../../shared/ui/AudioPlayer';
import { Button } from '../../../../shared/ui/Button';
import { FileChip, formatBytes } from '../../../../shared/ui/FileChip';
import { ImageThumbnail } from '../../../../shared/ui/ImageThumbnail';
import { InlineVideo } from '../../../../shared/ui/InlineVideo';
import {
  LinkifiedText,
  extractUrls,
} from '../../../../shared/ui/LinkifiedText';
import { setPendingDownloaderUrl } from '../../../downloader/pendingUrl';
import { LinkEmbed } from '../../../notes/LinkEmbed';

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

type VideoNoteItemProps = {
  filePath: string;
  durationSec: number | null;
};

/// Telegram's round "video note" (кружечок). Same mp4 container as a
/// regular video, but presented as a circle to match the chat UI. Sized
/// down vs. the rectangular `VideoItem` since these are always short
/// face-cam clips.
export const VideoNoteItem = ({ filePath, durationSec }: VideoNoteItemProps) => (
  <InlineVideo
    src={filePath}
    durationSec={durationSec}
    className="w-[200px] h-[200px] aspect-square rounded-full object-cover"
  />
);

type DocumentItemProps = {
  filePath: string;
  mimeType: string | null;
  caption: string | null;
};

/// Telegram lets you send the same file either as a media kind (photo
/// / voice / video) or as a generic document. The latter preserves the
/// original bytes — a PNG sent "as file" arrives as kind=`document`
/// with mime=`image/png`. Dispatch on the mime so the user still gets
/// a real preview instead of a paper-icon chip.
export const DocumentItem = ({ filePath, mimeType, caption }: DocumentItemProps) => {
  const mime = (mimeType ?? '').toLowerCase();
  if (mime.startsWith('image/')) {
    return (
      <ImageThumbnail
        src={filePath}
        alt={caption ?? basename(filePath)}
        caption={caption}
      />
    );
  }
  if (mime.startsWith('video/')) {
    return <InlineVideo src={filePath} caption={caption} />;
  }
  if (mime.startsWith('audio/')) {
    return (
      <div className="flex flex-col gap-1">
        <AudioPlayer src={filePath} caption={basename(filePath)} />
        {caption && (
          <p className="text-body text-white/80 whitespace-pre-wrap">
            {caption}
          </p>
        )}
      </div>
    );
  }
  return <FileChip name={basename(filePath)} mimeType={mimeType} caption={caption} />;
};

type TextItemProps = {
  content: string;
};

/// Plain-text message row. URLs get linkified in the body, and the
/// first URL also renders as a rich embed below: YouTube → inline
/// player, everything else → OG preview card (title, image, hostname)
/// driven by the existing `useLinkPreview` hook. A Download button
/// sits next to the embed so a pasted media URL still reaches the
/// Downloader module in one click.
export const TextItem = ({ content }: TextItemProps) => {
  const urls = extractUrls(content);
  const first = urls[0];
  return (
    <div className="flex flex-col gap-1.5">
      <LinkifiedText content={content} />
      {first && (
        <>
          <LinkEmbed href={first} />
          <div className="flex items-center gap-2 text-meta">
            <Button
              size="xs"
              variant="soft"
              tone="accent"
              title={`Send ${first} to Downloader`}
              onClick={() => {
                setPendingDownloaderUrl(first);
                window.dispatchEvent(
                  new CustomEvent('stash:navigate', { detail: 'downloads' }),
                );
              }}
            >
              ⤓ Download
            </Button>
            {urls.length > 1 && (
              <span className="text-white/40">+{urls.length - 1} more</span>
            )}
          </div>
        </>
      )}
    </div>
  );
};

// Re-export so existing callers of `formatBytes` from this file keep
// working — but new code should import directly from `shared/ui`.
export { formatBytes };
