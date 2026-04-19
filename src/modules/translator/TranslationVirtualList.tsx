import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { TranslationRow } from './TranslationRow';
import { estimateTranslationRowHeight } from './estimateRowHeight';
import type { TranslationRow as TranslationRowData } from './api';

interface TranslationVirtualListProps {
  rows: TranslationRowData[];
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
  onSpeak: (text: string, lang: string) => void;
  onReuse: (row: TranslationRowData) => void;
}

/// react-virtual scroller used once the history list exceeds
/// VIRTUALIZE_THRESHOLD entries. Kept in its own file per the
/// "one component per file" convention.
export const TranslationVirtualList = ({
  rows,
  onCopy,
  onDelete,
  onSpeak,
  onReuse,
}: TranslationVirtualListProps) => {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      const r = rows[i];
      return r ? estimateTranslationRowHeight(r) : 96;
    },
    overscan: 6,
    getItemKey: (i) => rows[i]?.id ?? i,
  });
  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto nice-scroll">
      <div style={{ height: totalSize, width: '100%', position: 'relative' }}>
        {items.map((virtualItem) => {
          const row = rows[virtualItem.index];
          if (!row) return null;
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
              <TranslationRow
                row={row}
                onCopy={onCopy}
                onDelete={onDelete}
                onSpeak={onSpeak}
                onReuse={onReuse}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};
