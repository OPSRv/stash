import { Button } from '../../shared/ui/Button';
import { EmptyState } from '../../shared/ui/EmptyState';
import { CloseIcon, SearchIcon } from '../../shared/ui/icons';
import { TranslationHistoryList } from './TranslationHistoryList';
import type { TranslationRow as TranslationRowData } from './api';

interface TranslatorHistoryPanelProps {
  rows: TranslationRowData[];
  query: string;
  onQueryChange: (query: string) => void;
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
  onSpeak: (text: string, lang: string) => void;
  onReuse: (row: TranslationRowData) => void;
  onClearAll: () => void;
}

/// History zone below the composer: search input + count + clear-all +
/// the grouped list itself. Keeps empty-state handling co-located so the
/// shell doesn't need to know how the list renders.
export const TranslatorHistoryPanel = ({
  rows,
  query,
  onQueryChange,
  onCopy,
  onDelete,
  onSpeak,
  onReuse,
  onClearAll,
}: TranslatorHistoryPanelProps) => {
  const hasQuery = query.trim().length > 0;
  const isEmptyList = rows.length === 0;

  if (isEmptyList && !hasQuery) {
    return (
      <div className="flex-1 overflow-hidden flex items-center justify-center border-t hair">
        <EmptyState
          variant="compact"
          title="No translations yet"
          description="Translate above, or enable auto-translate in Settings → Clipboard and copy foreign text."
        />
      </div>
    );
  }

  return (
    <>
      <div className="px-3 pt-2 pb-1.5 flex items-center gap-2 border-t hair shrink-0">
        <div className="flex-1 flex items-center gap-1.5 input-field ring-focus-within rounded-md px-2 py-1">
          <SearchIcon size={12} className="t-tertiary" />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.currentTarget.value)}
            placeholder="Search history"
            className="flex-1 bg-transparent outline-none text-meta min-w-0"
            aria-label="Search translation history"
          />
          {hasQuery && (
            <button
              type="button"
              onClick={() => onQueryChange('')}
              className="t-tertiary hover:t-primary ring-focus rounded"
              aria-label="Clear search"
            >
              <CloseIcon size={10} />
            </button>
          )}
        </div>
        <span className="t-tertiary text-meta shrink-0">{rows.length}</span>
        <Button size="xs" variant="ghost" onClick={onClearAll} disabled={isEmptyList}>
          Clear all
        </Button>
      </div>
      {isEmptyList ? (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState variant="compact" title="No matches" description="Try a different search." />
        </div>
      ) : (
        <TranslationHistoryList
          rows={rows}
          onCopy={onCopy}
          onDelete={onDelete}
          onSpeak={onSpeak}
          onReuse={onReuse}
        />
      )}
    </>
  );
};
