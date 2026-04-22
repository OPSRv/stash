import { memo, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { AskAiButton } from '../../shared/ui/AskAiButton';
import { IconButton } from '../../shared/ui/IconButton';
import { Kbd } from '../../shared/ui/Kbd';
import { Row } from '../../shared/ui/Row';
import { ExternalIcon, NoteIcon, PinIcon, TrashIcon } from '../../shared/ui/icons';
import type { ClipboardItem } from './api';
import type { ContentType, TextSubtype } from './contentType';
import { iconFor, typeTint } from './icons';
import { useLinkPreview } from './useLinkPreview';

type LinkRowItem = ClipboardItem & { type: ContentType; subtype: TextSubtype };

interface LinkRowProps {
  item: LinkRowItem;
  flatIndex: number;
  active: boolean;
  selected: boolean;
  onTogglePin: (id: number) => void;
  onDelete: (id: number) => void;
  onClick: (flatIndex: number, event?: ReactMouseEvent) => void;
  onSaveToNote: (id: number) => void;
  className?: string;
}

const isoAge = (ts: number): string => {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
};

/// A clipboard row for URL items. Lazy-fetches og:image / og:title from the
/// Rust side and renders a thumbnail + title pulled from the page metadata,
/// falling back to the default link icon when the page exposes no preview.
const LinkRowImpl = ({
  item,
  flatIndex,
  active,
  selected,
  onTogglePin,
  onDelete,
  onClick,
  onSaveToNote,
  className,
}: LinkRowProps) => {
  const preview = useLinkPreview(item.content);
  const tint = typeTint[item.type];
  const [isImageBroken, setIsImageBroken] = useState(false);
  const [isFaviconBroken, setIsFaviconBroken] = useState(false);
  const hasThumbnail = preview?.image != null && !isImageBroken;
  const host = useMemo(() => {
    try {
      return new URL(item.content).hostname || null;
    } catch {
      return null;
    }
  }, [item.content]);
  const hasFavicon = !hasThumbnail && !isFaviconBroken && host !== null;
  const thumb = hasThumbnail ? (
    <img
      src={preview.image ?? undefined}
      alt=""
      onError={() => setIsImageBroken(true)}
      className="w-7 h-7 rounded-md object-cover"
    />
  ) : hasFavicon ? (
    <img
      src={`https://www.google.com/s2/favicons?domain=${host}&sz=64`}
      alt=""
      onError={() => setIsFaviconBroken(true)}
      className="w-5 h-5 object-contain"
    />
  ) : (
    iconFor(item.type)
  );
  const primary = preview?.title ?? item.content;
  return (
    <Row
      primary={primary}
      icon={thumb}
      iconTint={hasThumbnail || hasFavicon ? 'transparent' : tint.bg}
      iconColor={tint.fg}
      actions={
        <>
          <IconButton
            onClick={async () => {
              try {
                const { openUrl } = await import('@tauri-apps/plugin-opener');
                await openUrl(item.content);
              } catch (e) {
                console.error('open url failed:', e);
              }
            }}
            title="Open in browser"
          >
            <ExternalIcon size={12} />
          </IconButton>
          <AskAiButton text={item.content} />
          <IconButton onClick={() => onSaveToNote(item.id)} title="Save to notes">
            <NoteIcon size={12} />
          </IconButton>
          <IconButton onClick={() => onTogglePin(item.id)} title={item.pinned ? 'Unpin' : 'Pin'}>
            <PinIcon size={12} filled={item.pinned} />
          </IconButton>
          <IconButton onClick={() => onDelete(item.id)} title="Delete" tone="danger">
            <TrashIcon size={12} />
          </IconButton>
        </>
      }
      meta={
        <>
          <span className="t-tertiary text-meta font-mono">{isoAge(item.created_at)}</span>
          {active && <Kbd>↵</Kbd>}
        </>
      }
      pinned={item.pinned}
      active={active}
      selected={selected}
      onSelect={(e) => onClick(flatIndex, e as ReactMouseEvent)}
      className={className}
    />
  );
};

/// Rows live inside a virtualised list that re-renders on every rawItems
/// update (pin, delete, new entry). Most updates don't touch *this* row's
/// visible fields, so skipping re-render when the visual inputs match is a
/// large cheap win — og:preview fetches remain cached in `useLinkPreview`.
export const LinkRow = memo(LinkRowImpl, (a, b) =>
  a.item.id === b.item.id &&
  a.item.content === b.item.content &&
  a.item.pinned === b.item.pinned &&
  a.item.type === b.item.type &&
  a.active === b.active &&
  a.selected === b.selected &&
  a.flatIndex === b.flatIndex &&
  a.className === b.className &&
  a.onTogglePin === b.onTogglePin &&
  a.onDelete === b.onDelete &&
  a.onClick === b.onClick &&
  a.onSaveToNote === b.onSaveToNote,
);
