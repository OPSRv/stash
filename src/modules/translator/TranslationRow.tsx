import { memo, type ReactNode } from 'react';
import { AskAiButton } from '../../shared/ui/AskAiButton';
import { Button } from '../../shared/ui/Button';
import { IconButton } from '../../shared/ui/IconButton';
import { ReuseIcon, SpeakerIcon, TrashIcon } from '../../shared/ui/icons';
import { isRtl, languageLabel } from './languages';
import type { TranslationRow as TranslationRowData } from './api';

interface TranslationRowProps {
  row: TranslationRowData;
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
  onSpeak: (text: string, lang: string) => void;
  onReuse: (row: TranslationRowData) => void;
}

const isoAge = (timestamp: number): string => {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
};

const languageArrow = (from: string, to: string): ReactNode => {
  const fromLabel = from === 'auto' ? '' : languageLabel(from);
  const toLabel = languageLabel(to);
  return (
    <span className="inline-flex items-center gap-1">
      {fromLabel && <span className="opacity-75">{fromLabel}</span>}
      <span className="opacity-60">→</span>
      <span>{toLabel}</span>
    </span>
  );
};

/// Memoised so history rows don't re-render on every keystroke in the
/// composer. Parent callbacks are stable (useCallback) and `row` is
/// reference-stable across reloads that don't touch the entry.
export const TranslationRow = memo(
  ({ row, onCopy, onDelete, onSpeak, onReuse }: TranslationRowProps) => (
    <div className="translator-row group relative mx-3 my-1 rounded-lg p-2.5 transition-colors hover:bg-white/[0.04]">
      <div className="flex items-center gap-2 mb-1">
        <span className="translator-pill px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wider t-primary uppercase">
          {languageArrow(row.from_lang, row.to_lang)}
        </span>
        <span className="t-tertiary text-[10px] font-mono">{isoAge(row.created_at)}</span>
      </div>
      <button
        type="button"
        onClick={() => onReuse(row)}
        className="block w-full min-w-0 text-left ring-focus rounded"
        title="Reuse as source (click)"
        aria-label="Reuse translation as source"
      >
        <div
          className="t-primary text-body leading-snug break-words"
          dir={isRtl(row.to_lang) ? 'rtl' : 'auto'}
        >
          {row.translated}
        </div>
        <div
          className="t-tertiary text-meta break-words mt-0.5 line-clamp-2"
          dir={isRtl(row.from_lang) ? 'rtl' : 'auto'}
        >
          {row.original}
        </div>
      </button>
      <div className="absolute top-2 right-2 hidden group-hover:flex group-focus-within:flex items-center gap-1 rounded-md px-1 py-0.5 bg-[var(--color-bg-pane)]/90 backdrop-blur-sm shadow-sm">
        <IconButton onClick={() => onReuse(row)} title="Reuse as source">
          <ReuseIcon size={12} />
        </IconButton>
        <IconButton onClick={() => onSpeak(row.translated, row.to_lang)} title="Listen">
          <SpeakerIcon size={12} />
        </IconButton>
        <AskAiButton text={row.translated} title="Ask AI about this translation (opens a new chat)" />
        <Button
          size="xs"
          variant="soft"
          tone="accent"
          onClick={() => onCopy(row.translated)}
          title="Copy translation"
        >
          Copy
        </Button>
        <IconButton onClick={() => onDelete(row.id)} title="Delete" tone="danger">
          <TrashIcon size={12} />
        </IconButton>
      </div>
    </div>
  ),
);
TranslationRow.displayName = 'TranslationRow';
