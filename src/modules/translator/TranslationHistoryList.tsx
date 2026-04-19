import { SectionLabel } from '../../shared/ui/SectionLabel';
import { TranslationRow } from './TranslationRow';
import { TranslationVirtualList } from './TranslationVirtualList';
import { groupByDate } from './groupByDate';
import { VIRTUALIZE_THRESHOLD } from './translator.constants';
import type { TranslationRow as TranslationRowData } from './api';

interface TranslationHistoryListProps {
  rows: TranslationRowData[];
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
  onSpeak: (text: string, lang: string) => void;
  onReuse: (row: TranslationRowData) => void;
}

/// Renders the history list. Below `VIRTUALIZE_THRESHOLD` uses a plain
/// map so jsdom-based tests see every row; above it delegates to
/// `TranslationVirtualList` so long histories stay smooth.
export const TranslationHistoryList = ({
  rows,
  onCopy,
  onDelete,
  onSpeak,
  onReuse,
}: TranslationHistoryListProps) => {
  if (rows.length >= VIRTUALIZE_THRESHOLD) {
    return (
      <TranslationVirtualList
        rows={rows}
        onCopy={onCopy}
        onDelete={onDelete}
        onSpeak={onSpeak}
        onReuse={onReuse}
      />
    );
  }
  const grouped = groupByDate(rows);
  return (
    <div className="flex-1 overflow-y-auto nice-scroll pb-2">
      {grouped.map((group) => (
        <div key={group.group}>
          <div className="px-4 pt-3 pb-0.5">
            <SectionLabel>{group.label}</SectionLabel>
          </div>
          {group.rows.map((row) => (
            <TranslationRow
              key={row.id}
              row={row}
              onCopy={onCopy}
              onDelete={onDelete}
              onSpeak={onSpeak}
              onReuse={onReuse}
            />
          ))}
        </div>
      ))}
    </div>
  );
};
