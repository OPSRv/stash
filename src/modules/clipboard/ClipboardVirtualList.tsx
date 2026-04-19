import { useMemo, type ReactNode } from 'react';
import { EmptyState } from '../../shared/ui/EmptyState';
import { SectionLabel } from '../../shared/ui/SectionLabel';
import { ClipboardVirtualListBody, type VirtualEntry } from './ClipboardVirtualListBody';
import type { ClipboardItem } from './api';
import type { ContentType } from './contentType';

type TypedItem = ClipboardItem & { type: ContentType };

interface ClipboardVirtualListProps {
  empty: boolean;
  query: string;
  pinned: TypedItem[];
  recent: TypedItem[];
  renderRow: (item: TypedItem, flatIndex: number) => ReactNode;
}

/// Below this many entries the cost of measuring/positioning rows outweighs
/// the savings from virtualisation, so we render the list normally.
const VIRTUALIZE_THRESHOLD = 60;

const buildEntries = (pinned: TypedItem[], recent: TypedItem[]): VirtualEntry[] => {
  const out: VirtualEntry[] = [];
  if (pinned.length) {
    out.push({ kind: 'label', key: 'label-pinned', label: 'Pinned' });
    pinned.forEach((item, i) => out.push({ kind: 'row', key: item.id, item, flatIndex: i }));
  }
  if (recent.length) {
    out.push({ kind: 'label', key: 'label-recent', label: 'Recent' });
    recent.forEach((item, i) =>
      out.push({ kind: 'row', key: item.id, item, flatIndex: pinned.length + i }),
    );
  }
  return out;
};

const renderEntry = (
  entry: VirtualEntry,
  renderRow: ClipboardVirtualListProps['renderRow'],
): ReactNode =>
  entry.kind === 'label' ? (
    <div className="px-3 pt-3 pb-1">
      <SectionLabel>{entry.label}</SectionLabel>
    </div>
  ) : (
    renderRow(entry.item, entry.flatIndex)
  );

/// Renders the clipboard list. Below VIRTUALIZE_THRESHOLD uses a plain map
/// so jsdom-based tests see every row; above it delegates to
/// ClipboardVirtualListBody so long histories stay smooth.
export const ClipboardVirtualList = ({
  empty,
  query,
  pinned,
  recent,
  renderRow,
}: ClipboardVirtualListProps) => {
  const entries = useMemo(() => buildEntries(pinned, recent), [pinned, recent]);

  if (empty && !query) {
    return (
      <div className="flex-1 overflow-hidden flex items-center justify-center">
        <EmptyState
          title="Nothing copied yet"
          description="Copy anything — text, a link, an image — and it shows up here. Press Enter to paste at the cursor."
        />
      </div>
    );
  }
  if (empty && query) {
    return (
      <div className="flex-1 overflow-hidden flex items-center justify-center">
        <EmptyState variant="compact" title="No matches" description="Try a different search." />
      </div>
    );
  }

  if (entries.length < VIRTUALIZE_THRESHOLD) {
    return (
      <div className="flex-1 overflow-y-auto nice-scroll" role="listbox">
        {entries.map((entry) => (
          <div key={entry.key}>{renderEntry(entry, renderRow)}</div>
        ))}
      </div>
    );
  }
  return <ClipboardVirtualListBody entries={entries} renderRow={renderRow} />;
};
