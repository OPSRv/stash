import { useRef, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { SectionLabel } from '../../shared/ui/SectionLabel';
import type { ClipboardItem } from './api';
import type { ContentType, TextSubtype } from './contentType';

type TypedItem = ClipboardItem & { type: ContentType; subtype: TextSubtype };

export type VirtualEntry =
  | { kind: 'label'; key: string; label: string }
  | { kind: 'row'; key: number; item: TypedItem; flatIndex: number };

interface ClipboardVirtualListBodyProps {
  entries: VirtualEntry[];
  renderRow: (item: TypedItem, flatIndex: number) => ReactNode;
}

const renderEntry = (
  entry: VirtualEntry,
  renderRow: ClipboardVirtualListBodyProps['renderRow'],
): ReactNode =>
  entry.kind === 'label' ? (
    <div className="px-3 pt-3 pb-1">
      <SectionLabel>{entry.label}</SectionLabel>
    </div>
  ) : (
    renderRow(entry.item, entry.flatIndex)
  );

/// Virtual-scroll body used by ClipboardVirtualList once the entry count
/// crosses the virtualisation threshold. Extracted so ClipboardVirtualList
/// stays a single-component file per project conventions.
export const ClipboardVirtualListBody = ({
  entries,
  renderRow,
}: ClipboardVirtualListBodyProps) => {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (entries[i]?.kind === 'label' ? 32 : 52),
    overscan: 8,
    getItemKey: (i) => entries[i]?.key ?? i,
  });
  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto nice-scroll" role="listbox">
      <div style={{ height: totalSize, width: '100%', position: 'relative' }}>
        {items.map((virtualItem) => {
          const entry = entries[virtualItem.index];
          if (!entry) return null;
          return (
            <div
              key={virtualItem.key}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              {renderEntry(entry, renderRow)}
            </div>
          );
        })}
      </div>
    </div>
  );
};
