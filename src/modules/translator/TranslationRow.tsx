import { memo, type ReactNode } from 'react';
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
    <div className="translator-row group mx-3 my-1 rounded-lg p-2.5 flex items-start gap-2 transition-colors hover:bg-white/[0.04]">
      <span className="translator-pill px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wider t-primary shrink-0 uppercase">
        {languageArrow(row.from_lang, row.to_lang)}
      </span>
      <button
        type="button"
        onClick={() => onReuse(row)}
        className="flex-1 min-w-0 text-left ring-focus rounded"
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
        <div className="t-tertiary text-[10px] font-mono mt-1">{isoAge(row.created_at)}</div>
      </button>
      <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <IconButton onClick={() => onReuse(row)} title="Reuse as source">
          <ReuseIcon size={12} />
        </IconButton>
        <IconButton onClick={() => onSpeak(row.translated, row.to_lang)} title="Listen">
          <SpeakerIcon size={12} />
        </IconButton>
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
