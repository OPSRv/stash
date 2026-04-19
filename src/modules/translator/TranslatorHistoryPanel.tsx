import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '../../shared/ui/Button';
import { EmptyState } from '../../shared/ui/EmptyState';
import { IconButton } from '../../shared/ui/IconButton';
import { CloseIcon, SearchIcon } from '../../shared/ui/icons';
import { TranslationHistoryList } from './TranslationHistoryList';
import type { TranslationRow as TranslationRowData } from './api';

interface TranslatorHistoryPanelProps {
  isOpen: boolean;
  onClose: () => void;
  rows: TranslationRowData[];
  query: string;
  onQueryChange: (query: string) => void;
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
  onSpeak: (text: string, lang: string) => void;
  onReuse: (row: TranslationRowData) => void;
  onClearAll: () => void;
}

/// Slide-in drawer on the right edge. Stays mounted for the closing
/// animation via `data-state`, then unmounts on animationend. Animations
/// and colour live in `translator-animations.css`.
export const TranslatorHistoryPanel = ({
  isOpen,
  onClose,
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
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [rendered, setRendered] = useState(isOpen);
  const state: 'opening' | 'closing' = isOpen ? 'opening' : 'closing';

  useEffect(() => {
    if (isOpen) setRendered(true);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    searchRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  /// ↑/↓ on the search input moves focus into the grouped list.
  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rowButtons = listRef.current?.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Reuse translation as source"]',
    );
    if (!rowButtons || rowButtons.length === 0) return;
    e.preventDefault();
    const target = e.key === 'ArrowDown' ? rowButtons[0] : rowButtons[rowButtons.length - 1];
    target.focus();
  };

  if (!rendered) return null;

  return (
    <>
      <div
        className="translator-history-scrim"
        data-state={state === 'closing' ? 'closing' : undefined}
        onClick={onClose}
        onAnimationEnd={() => {
          if (!isOpen) setRendered(false);
        }}
        aria-hidden="true"
      />
      <aside
        className="translator-history-drawer"
        data-state={state === 'closing' ? 'closing' : undefined}
        role="dialog"
        aria-label="Translation history"
      >
        <div className="px-3 pt-3 pb-1.5 flex items-center gap-2 shrink-0">
          <span className="text-title font-medium flex-1">History</span>
          <span className="t-tertiary text-meta">{rows.length}</span>
          <Button size="xs" variant="ghost" onClick={onClearAll} disabled={isEmptyList}>
            Clear all
          </Button>
          <IconButton onClick={onClose} title="Close history (Esc)" stopPropagation={false}>
            <CloseIcon size={12} />
          </IconButton>
        </div>
        <div className="px-3 pb-2 shrink-0">
          <div className="flex items-center gap-1.5 input-field ring-focus-within rounded-md px-2 py-1">
            <SearchIcon size={12} className="t-tertiary" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => onQueryChange(e.currentTarget.value)}
              onKeyDown={onSearchKeyDown}
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
        </div>
        {isEmptyList ? (
          <div className="flex-1 flex items-center justify-center">
            <EmptyState
              variant="compact"
              title={hasQuery ? 'No matches' : 'No translations yet'}
              description={
                hasQuery
                  ? 'Try a different search.'
                  : 'Translate above, or enable auto-translate in Settings → Clipboard and copy foreign text.'
              }
            />
          </div>
        ) : (
          <div ref={listRef} className="flex-1 min-h-0 flex flex-col">
            <TranslationHistoryList
              rows={rows}
              onCopy={onCopy}
              onDelete={onDelete}
              onSpeak={onSpeak}
              onReuse={onReuse}
            />
          </div>
        )}
      </aside>
    </>
  );
};
