import { useState, type MouseEvent as ReactMouseEvent } from 'react';
import { IconButton } from '../../shared/ui/IconButton';
import { Kbd } from '../../shared/ui/Kbd';
import { Row } from '../../shared/ui/Row';
import { PinIcon, TrashIcon } from '../../shared/ui/icons';
import type { ClipboardItem } from './api';
import type { ContentType } from './contentType';
import { iconFor, typeTint } from './icons';
import { useLinkPreview } from './useLinkPreview';

type LinkRowItem = ClipboardItem & { type: ContentType };

interface LinkRowProps {
  item: LinkRowItem;
  flatIndex: number;
  active: boolean;
  selected: boolean;
  onTogglePin: (id: number) => void;
  onDelete: (id: number) => void;
  onClick: (flatIndex: number, event?: ReactMouseEvent) => void;
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
export const LinkRow = ({
  item,
  flatIndex,
  active,
  selected,
  onTogglePin,
  onDelete,
  onClick,
}: LinkRowProps) => {
  const preview = useLinkPreview(item.content);
  const tint = typeTint[item.type];
  const [isImageBroken, setIsImageBroken] = useState(false);
  const hasThumbnail = preview?.image != null && !isImageBroken;
  const thumb = hasThumbnail ? (
    <img
      src={preview.image}
      alt=""
      onError={() => setIsImageBroken(true)}
      className="w-7 h-7 rounded-md object-cover"
    />
  ) : (
    iconFor(item.type)
  );
  const primary = preview?.title ?? item.content;
  return (
    <Row
      primary={primary}
      icon={thumb}
      iconTint={hasThumbnail ? 'transparent' : tint.bg}
      iconColor={tint.fg}
      actions={
        <>
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
    />
  );
};
