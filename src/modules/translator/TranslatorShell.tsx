import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { listen } from '@tauri-apps/api/event';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { SectionLabel } from '../../shared/ui/SectionLabel';
import {
  CloseIcon,
  ReuseIcon,
  SearchIcon,
  SpeakerIcon,
  SwapIcon,
  TrashIcon,
} from '../../shared/ui/icons';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { Select } from '../../shared/ui/Select';
import { Spinner } from '../../shared/ui/Spinner';
import { Button } from '../../shared/ui/Button';
import { IconButton } from '../../shared/ui/IconButton';
import { Kbd } from '../../shared/ui/Kbd';
import { Card } from '../../shared/ui/Card';
import { Badge } from '../../shared/ui/Badge';
import { EmptyState } from '../../shared/ui/EmptyState';
import { useToast } from '../../shared/ui/Toast';
import { useAnnounce } from '../../shared/ui/LiveRegion';
import { useSuppressibleConfirm } from '../../shared/hooks/useSuppressibleConfirm';
import { loadSettings, saveSetting } from '../../settings/store';
import { TARGET_LANGUAGES, isRtl, languageLabel } from './languages';
import { groupByDate } from './groupByDate';
import {
  translate,
  translatorClear,
  translatorDelete,
  translatorList,
  translatorSearch,
  type TranslationRow,
} from './api';

const iso = (ts: number) => {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
};

const MAX_CHARS = 5000;
const WARN_CHARS = 4500;

type LiveResult = {
  original: string;
  translated: string;
  from: string;
  to: string;
};

export const TranslatorShell = () => {
  const [rows, setRows] = useState<TranslationRow[]>([]);
  const [clearOpen, setClearOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [sourceHint, setSourceHint] = useState<string | null>(null);
  const [target, setTarget] = useState('en');
  const [busy, setBusy] = useState(false);
  const [liveResult, setLiveResult] = useState<LiveResult | null>(null);
  const [historyQuery, setHistoryQuery] = useState('');
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const lastTranslatedRef = useRef<{ text: string; to: string } | null>(null);
  const { toast } = useToast();
  const { announce } = useAnnounce();
  const deleteConfirm = useSuppressibleConfirm<number>('translator.delete');

  useEffect(() => {
    loadSettings()
      .then((s) => setTarget(s.translateTarget || 'en'))
      .catch(() => {});
  }, []);

  const runTranslate = useCallback(
    async (rawText: string, to: string, from?: string) => {
      const text = rawText.trim();
      if (!text) return;
      lastTranslatedRef.current = { text, to };
      setBusy(true);
      try {
        const result = await translate(text, to, from);
        setLiveResult({
          original: result.original,
          translated: result.translated,
          from: result.from,
          to: result.to,
        });
        announce('Translation ready');
        const list = await translatorList();
        setRows(list);
      } catch (e) {
        console.error('manual translate failed', e);
        toast({
          title: 'Translate failed',
          description: String(e),
          variant: 'error',
          action: { label: 'Retry', onClick: () => void runTranslate(text, to, from) },
        });
      } finally {
        setBusy(false);
      }
    },
    [toast, announce],
  );

  // Auto-translate as the user types or pastes — debounced so short bursts
  // of keystrokes collapse into a single call, but paste feels immediate.
  useEffect(() => {
    const text = draft.trim();
    if (!text) {
      setLiveResult(null);
      lastTranslatedRef.current = null;
      return;
    }
    const last = lastTranslatedRef.current;
    if (last && last.text === text && last.to === target) return;
    const t = window.setTimeout(() => {
      void runTranslate(text, target, sourceHint ?? undefined);
    }, 450);
    return () => window.clearTimeout(t);
  }, [draft, target, sourceHint, runTranslate]);

  const onTargetChange = useCallback((next: string) => {
    setTarget(next);
    saveSetting('translateTarget', next).catch(() => {});
  }, []);

  const detectedFrom = liveResult?.from ?? null;
  const canSwap =
    detectedFrom != null &&
    detectedFrom !== 'auto' &&
    detectedFrom !== target &&
    TARGET_LANGUAGES.some((l) => l.code === detectedFrom);

  const onSwap = useCallback(() => {
    if (!liveResult || !canSwap) return;
    const nextTarget = liveResult.from;
    const nextDraft = liveResult.translated;
    setTarget(nextTarget);
    saveSetting('translateTarget', nextTarget).catch(() => {});
    setDraft(nextDraft);
    // Prior result is from the opposite direction — clear so the spinner
    // shows while the new direction resolves.
    setLiveResult(null);
    lastTranslatedRef.current = null;
    setSourceHint(null);
    announce(`Swapped — translating ${languageLabel(liveResult.to)} to ${languageLabel(nextTarget)}`);
  }, [liveResult, canSwap, announce]);

  const reload = useCallback(() => {
    translatorList()
      .then(setRows)
      .catch((e) => console.error('translator list failed', e));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // History search — debounce to avoid per-keystroke IPC.
  useEffect(() => {
    const q = historyQuery.trim();
    if (!q) {
      reload();
      return;
    }
    const t = window.setTimeout(() => {
      translatorSearch(q).then(setRows).catch(() => {});
    }, 150);
    return () => window.clearTimeout(t);
  }, [historyQuery, reload]);

  // Refresh the list whenever a new auto-translation lands.
  useEffect(() => {
    const unlisten = listen('clipboard:translated', () => {
      if (!historyQuery.trim()) reload();
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [reload, historyQuery]);

  const speak = useCallback((text: string, lang: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === 'auto' ? 'en' : lang;
    window.speechSynthesis.speak(u);
  }, []);

  const onCopy = useCallback(
    async (text: string) => {
      try {
        await writeText(text);
        announce('Copied');
        toast({ title: 'Copied', variant: 'success', durationMs: 2000 });
      } catch (e) {
        console.error('copy failed', e);
        toast({ title: 'Copy failed', description: String(e), variant: 'error' });
      }
    },
    [toast, announce],
  );

  const performDelete = useCallback(
    async (id: number) => {
      try {
        await translatorDelete(id);
        announce('Translation deleted');
        reload();
      } catch (e) {
        console.error('delete failed', e);
      }
    },
    [reload, announce],
  );

  const onDelete = useCallback(
    (id: number) => deleteConfirm.request(id, performDelete),
    [deleteConfirm, performDelete],
  );

  const onReuse = useCallback((row: TranslationRow) => {
    setDraft(row.translated);
    setSourceHint(row.to_lang);
    setLiveResult(null);
    lastTranslatedRef.current = null;
    draftRef.current?.focus();
  }, []);

  const onClearDraft = useCallback(() => {
    setDraft('');
    setLiveResult(null);
    lastTranslatedRef.current = null;
    setSourceHint(null);
    draftRef.current?.focus();
  }, []);

  const onClearAll = useCallback(() => setClearOpen(true), []);

  const confirmClearAll = useCallback(async () => {
    setClearOpen(false);
    try {
      await translatorClear();
      reload();
      announce('History cleared');
      toast({ title: 'Translations cleared', variant: 'success' });
    } catch (e) {
      console.error('clear failed', e);
      toast({ title: 'Clear failed', description: String(e), variant: 'error' });
    }
  }, [reload, toast, announce]);

  // Module-level shortcuts. Scoped to the visible tab by PopupShell.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      const typing =
        tgt?.tagName === 'INPUT' ||
        tgt?.tagName === 'TEXTAREA' ||
        (tgt as HTMLElement | null)?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        draftRef.current?.focus();
        draftRef.current?.select();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (canSwap) onSwap();
        return;
      }
      if (e.key === 'Escape' && !typing && draft) {
        e.preventDefault();
        onClearDraft();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canSwap, onSwap, onClearDraft, draft]);

  const charsOver = draft.length > MAX_CHARS;
  const charsWarn = draft.length > WARN_CHARS;
  const fromLabel = detectedFrom
    ? languageLabel(detectedFrom)
    : sourceHint
      ? languageLabel(sourceHint)
      : 'Auto-detect';
  const toLabel = languageLabel(target);

  return (
    <div className="h-full flex flex-col">
      {/* Header: from chip — swap — to select */}
      <div className="px-3 pt-3 pb-2 flex items-center gap-2 shrink-0">
        <Badge tone={detectedFrom ? 'accent' : 'neutral'} className="flex-1 justify-start">
          <span className="opacity-70 mr-1">From</span>
          {fromLabel}
        </Badge>
        <IconButton
          onClick={onSwap}
          title={canSwap ? 'Swap languages (⌘⇧S)' : 'Swap unavailable for auto-detect'}
          tone={canSwap ? 'default' : 'default'}
          stopPropagation={false}
        >
          <SwapIcon size={13} className={canSwap ? '' : 'opacity-40'} />
        </IconButton>
        <div className="flex items-center gap-1.5">
          <span className="t-tertiary text-meta">To</span>
          <Select
            label="Target language"
            value={target}
            onChange={onTargetChange}
            options={TARGET_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
          />
        </div>
      </div>

      {/* Two-pane composer */}
      <div className="mx-3 mb-2 grid grid-cols-2 gap-2 shrink-0">
        <Card padding="sm" rounded="lg" className="flex flex-col min-h-[120px]">
          <div className="flex items-center justify-between mb-1">
            <SectionLabel>{fromLabel}</SectionLabel>
            {draft && (
              <button
                type="button"
                onClick={onClearDraft}
                className="t-tertiary hover:t-primary text-meta ring-focus rounded"
                title="Clear (Esc)"
                aria-label="Clear source"
              >
                <CloseIcon size={12} />
              </button>
            )}
          </div>
          <textarea
            ref={draftRef}
            aria-label="Text to translate"
            value={draft}
            onChange={(e) => {
              setSourceHint(null);
              setDraft(e.currentTarget.value);
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void runTranslate(draft, target, sourceHint ?? undefined);
              }
            }}
            dir={isRtl(detectedFrom ?? sourceHint) ? 'rtl' : 'auto'}
            placeholder="Paste or type — auto-translates"
            rows={4}
            maxLength={MAX_CHARS + 200}
            className="bg-transparent outline-none resize-none t-primary text-body leading-snug flex-1"
          />
          <div className="flex items-center justify-between mt-1">
            <span
              className={
                charsOver
                  ? 'text-meta'
                  : charsWarn
                    ? 'text-meta'
                    : 't-tertiary text-meta'
              }
              style={
                charsOver
                  ? { color: 'var(--color-danger-fg)' }
                  : charsWarn
                    ? { color: 'var(--color-warning-fg)' }
                    : undefined
              }
            >
              {draft.length > 0 ? `${draft.length.toLocaleString()} / ${MAX_CHARS.toLocaleString()}` : ''}
            </span>
            {draft.trim() && (
              <IconButton
                onClick={() => speak(draft, sourceHint ?? detectedFrom ?? 'en')}
                title="Listen to source"
                stopPropagation={false}
              >
                <SpeakerIcon size={12} />
              </IconButton>
            )}
          </div>
        </Card>

        <Card padding="sm" rounded="lg" tone={liveResult ? 'accent' : 'neutral'} className="flex flex-col min-h-[120px] relative">
          <div className="flex items-center justify-between mb-1">
            <SectionLabel>{toLabel}</SectionLabel>
            {busy && <Spinner size={11} />}
          </div>
          <div
            className="flex-1 t-primary text-body leading-snug break-words overflow-y-auto nice-scroll"
            dir={isRtl(target) ? 'rtl' : 'auto'}
            aria-live="polite"
          >
            {liveResult?.translated ?? (
              <span className="t-tertiary">
                {busy ? 'Translating…' : 'Translation appears here'}
              </span>
            )}
          </div>
          {liveResult && (
            <div className="flex items-center justify-end gap-1 mt-1">
              <IconButton
                onClick={() => speak(liveResult.translated, liveResult.to)}
                title="Listen"
                stopPropagation={false}
              >
                <SpeakerIcon size={12} />
              </IconButton>
              <Button
                size="xs"
                variant="soft"
                tone="accent"
                onClick={() => onCopy(liveResult.translated)}
                title="Copy translation"
              >
                Copy
              </Button>
            </div>
          )}
        </Card>
      </div>

      {/* Hint bar */}
      <div className="px-3 pb-2 flex items-center justify-between text-meta t-tertiary shrink-0">
        <span className="flex items-center gap-1.5">
          <Kbd>⌘K</Kbd> focus
          <Kbd>⌘↵</Kbd> translate
          {canSwap && (
            <>
              <Kbd>⌘⇧S</Kbd> swap
            </>
          )}
        </span>
        {busy ? <span>Working…</span> : null}
      </div>

      {/* History */}
      <HistoryPanel
        rows={rows}
        query={historyQuery}
        onQuery={setHistoryQuery}
        onCopy={onCopy}
        onDelete={onDelete}
        onSpeak={speak}
        onReuse={onReuse}
        onClearAll={onClearAll}
      />

      <ConfirmDialog
        open={clearOpen}
        title="Clear translations?"
        description="All translation history will be removed."
        confirmLabel="Clear"
        tone="danger"
        onConfirm={confirmClearAll}
        onCancel={() => setClearOpen(false)}
      />
      <ConfirmDialog
        open={deleteConfirm.open}
        title="Delete this translation?"
        description="The entry will be removed from history."
        confirmLabel="Delete"
        tone="danger"
        suppressibleLabel="Don't ask again"
        onConfirm={(suppress) => deleteConfirm.confirm(!!suppress)}
        onCancel={deleteConfirm.cancel}
      />
    </div>
  );
};

interface HistoryPanelProps {
  rows: TranslationRow[];
  query: string;
  onQuery: (q: string) => void;
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
  onSpeak: (text: string, lang: string) => void;
  onReuse: (row: TranslationRow) => void;
  onClearAll: () => void;
}

const HistoryPanel = ({
  rows,
  query,
  onQuery,
  onCopy,
  onDelete,
  onSpeak,
  onReuse,
  onClearAll,
}: HistoryPanelProps) => {
  const grouped = useMemo(() => groupByDate(rows), [rows]);

  if (rows.length === 0 && !query) {
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
            onChange={(e) => onQuery(e.currentTarget.value)}
            placeholder="Search history"
            className="flex-1 bg-transparent outline-none text-meta min-w-0"
            aria-label="Search translation history"
          />
          {query && (
            <button
              type="button"
              onClick={() => onQuery('')}
              className="t-tertiary hover:t-primary ring-focus rounded"
              aria-label="Clear search"
            >
              <CloseIcon size={10} />
            </button>
          )}
        </div>
        <span className="t-tertiary text-meta shrink-0">{rows.length}</span>
        <Button size="xs" variant="ghost" onClick={onClearAll} disabled={rows.length === 0}>
          Clear all
        </Button>
      </div>
      {rows.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState variant="compact" title="No matches" description="Try a different search." />
        </div>
      ) : (
        <TranslationHistory
          grouped={grouped}
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

interface HistoryProps {
  grouped: ReturnType<typeof groupByDate>;
  rows: TranslationRow[];
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
  onSpeak: (text: string, lang: string) => void;
  onReuse: (row: TranslationRow) => void;
}

/// Switch to virtual scroller once enough rows accumulate that layout cost
/// outpaces the virtualizer's overhead. Below the threshold, the plain
/// `.map` render keeps tests simple (jsdom can't measure layout).
const VIRTUALIZE_THRESHOLD = 40;

const TranslationHistory = ({ grouped, rows, onCopy, onDelete, onSpeak, onReuse }: HistoryProps) => {
  if (rows.length < VIRTUALIZE_THRESHOLD) {
    return (
      <div className="flex-1 overflow-y-auto nice-scroll pb-2">
        {grouped.map((g) => (
          <div key={g.group}>
            <div className="px-4 pt-3 pb-0.5">
              <SectionLabel>{g.label}</SectionLabel>
            </div>
            {g.rows.map((row) => (
              <TranslationRowView
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
  }
  return (
    <VirtualHistory
      rows={rows}
      onCopy={onCopy}
      onDelete={onDelete}
      onSpeak={onSpeak}
      onReuse={onReuse}
    />
  );
};

interface VirtualProps {
  rows: TranslationRow[];
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
  onSpeak: (text: string, lang: string) => void;
  onReuse: (row: TranslationRow) => void;
}

const VirtualHistory = ({ rows, onCopy, onDelete, onSpeak, onReuse }: VirtualProps) => {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 96,
    overscan: 6,
    getItemKey: (i) => rows[i]?.id ?? i,
  });
  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto nice-scroll">
      <div style={{ height: totalSize, width: '100%', position: 'relative' }}>
        {items.map((vi) => {
          const row = rows[vi.index];
          if (!row) return null;
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${vi.start}px)`,
              }}
            >
              <TranslationRowView
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

interface RowViewProps {
  row: TranslationRow;
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
  onSpeak: (text: string, lang: string) => void;
  onReuse: (row: TranslationRow) => void;
}

const langPillStyle = {
  background: 'rgba(var(--stash-accent-rgb), 0.22)',
} as const;

const langArrowLabel = (from: string, to: string): ReactNode => {
  const fromLabel =
    from === 'auto' ? '' : languageLabel(from);
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
/// translate textarea. Parent callbacks are stable, and `row` is
/// reference-stable across reloads.
const TranslationRowView = memo(({ row, onCopy, onDelete, onSpeak, onReuse }: RowViewProps) => (
  <div
    className="group mx-3 my-1 rounded-lg p-2.5 flex items-start gap-2 transition-colors hover:bg-white/[0.04]"
    style={{
      background: 'rgba(255,255,255,0.02)',
      border: '1px solid rgba(255,255,255,0.05)',
    }}
  >
    <span
      className="px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wider t-primary shrink-0 uppercase"
      style={langPillStyle}
    >
      {langArrowLabel(row.from_lang, row.to_lang)}
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
      <div className="t-tertiary text-[10px] font-mono mt-1">{iso(row.created_at)}</div>
    </button>
    <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
      <IconButton
        onClick={() => onReuse(row)}
        title="Reuse as source"
      >
        <ReuseIcon size={12} />
      </IconButton>
      <IconButton
        onClick={() => onSpeak(row.translated, row.to_lang)}
        title="Listen"
      >
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
      <IconButton
        onClick={() => onDelete(row.id)}
        title="Delete"
        tone="danger"
      >
        <TrashIcon size={12} />
      </IconButton>
    </div>
  </div>
));
TranslationRowView.displayName = 'TranslationRowView';
