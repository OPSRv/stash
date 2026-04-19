import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { listen } from '@tauri-apps/api/event';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { SectionLabel } from '../../shared/ui/SectionLabel';
import { CloseIcon } from '../../shared/ui/icons';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { Select } from '../../shared/ui/Select';
import { Spinner } from '../../shared/ui/Spinner';
import { Button } from '../../shared/ui/Button';
import { useToast } from '../../shared/ui/Toast';
import { useAnnounce } from '../../shared/ui/LiveRegion';
import { loadSettings, saveSetting } from '../../settings/store';
import { TARGET_LANGUAGES } from './languages';
import {
  translate,
  translatorClear,
  translatorDelete,
  translatorList,
  type TranslationRow,
} from './api';

const iso = (ts: number) => {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
};

export const TranslatorShell = () => {
  const [rows, setRows] = useState<TranslationRow[]>([]);
  const [clearOpen, setClearOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [target, setTarget] = useState('en');
  const [busy, setBusy] = useState(false);
  const [liveResult, setLiveResult] = useState<{ original: string; translated: string; to: string } | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const lastTranslatedRef = useRef<{ text: string; to: string } | null>(null);
  const { toast } = useToast();
  const { announce } = useAnnounce();

  useEffect(() => {
    loadSettings()
      .then((s) => setTarget(s.translateTarget || 'en'))
      .catch(() => {});
  }, []);

  const runTranslate = useCallback(
    async (rawText: string, to: string) => {
      const text = rawText.trim();
      if (!text) return;
      lastTranslatedRef.current = { text, to };
      setBusy(true);
      try {
        const result = await translate(text, to);
        setLiveResult({ original: result.original, translated: result.translated, to: result.to });
        announce('Translation ready');
        const list = await translatorList();
        setRows(list);
      } catch (e) {
        console.error('manual translate failed', e);
        toast({
          title: 'Translate failed',
          description: String(e),
          variant: 'error',
          action: { label: 'Retry', onClick: () => void runTranslate(text, to) },
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
      void runTranslate(text, target);
    }, 450);
    return () => window.clearTimeout(t);
  }, [draft, target, runTranslate]);

  const onTargetChange = useCallback((next: string) => {
    setTarget(next);
    saveSetting('translateTarget', next).catch(() => {});
  }, []);

  const reload = useCallback(() => {
    translatorList()
      .then(setRows)
      .catch((e) => console.error('translator list failed', e));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // Refresh the list whenever a new auto-translation lands.
  useEffect(() => {
    const unlisten = listen('clipboard:translated', () => reload());
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [reload]);

  const speak = useCallback((text: string, lang: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    window.speechSynthesis.speak(u);
  }, []);

  const onCopy = useCallback(async (text: string) => {
    try {
      await writeText(text);
      toast({ title: 'Copied', variant: 'success', durationMs: 2000 });
    } catch (e) {
      console.error('copy failed', e);
      toast({ title: 'Copy failed', description: String(e), variant: 'error' });
    }
  }, [toast]);

  const onDelete = useCallback(
    async (id: number) => {
      try {
        await translatorDelete(id);
        reload();
      } catch (e) {
        console.error('delete failed', e);
      }
    },
    [reload]
  );

  const onClearAll = useCallback(() => setClearOpen(true), []);

  const confirmClearAll = useCallback(async () => {
    setClearOpen(false);
    try {
      await translatorClear();
      reload();
      toast({ title: 'Translations cleared', variant: 'success' });
    } catch (e) {
      console.error('clear failed', e);
      toast({ title: 'Clear failed', description: String(e), variant: 'error' });
    }
  }, [reload, toast]);

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 pt-3 pb-2 border-b hair">
        <div className="flex items-center justify-between mb-1.5">
          <SectionLabel>Translate text</SectionLabel>
          <div className="flex items-center gap-2">
            <span className="t-tertiary text-meta">into</span>
            <Select
              label="Target language"
              value={target}
              onChange={onTargetChange}
              options={TARGET_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
            />
          </div>
        </div>
        <textarea
          ref={draftRef}
          aria-label="Text to translate"
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void runTranslate(draft, target);
            }
          }}
          placeholder="Type or paste text — it translates automatically"
          rows={2}
          className="input-field rounded-md px-2 py-1.5 w-full text-body resize-none"
        />
        <div className="flex items-center justify-between mt-1.5">
          <span className="t-tertiary text-meta">
            {draft.length > 0 ? `${draft.length} chars` : 'Source language is detected automatically'}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void runTranslate(draft, target)}
            disabled={busy || draft.trim().length === 0}
            leadingIcon={busy ? <Spinner size={12} /> : undefined}
            title="Translate now (⌘↵)"
          >
            {busy ? 'Translating…' : 'Translate now'}
          </Button>
        </div>
        {liveResult && (
          <div
            className="mt-2 rounded-md p-2 flex items-start gap-2"
            style={{ background: 'rgba(var(--stash-accent-rgb), 0.12)', border: '1px solid rgba(var(--stash-accent-rgb), 0.25)' }}
          >
            <span
              className="px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wider t-primary shrink-0 uppercase"
              style={{ background: 'rgba(var(--stash-accent-rgb), 0.22)' }}
            >
              → {liveResult.to}
            </span>
            <div className="flex-1 min-w-0 t-primary text-body leading-snug break-words">
              {liveResult.translated}
            </div>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => speak(liveResult.translated, liveResult.to)}
              title="Speak"
              aria-label="Speak translation"
              className="shrink-0"
            >
              🔊
            </Button>
            <Button
              size="xs"
              variant="soft"
              onClick={() => onCopy(liveResult.translated)}
              title="Copy translation"
              className="shrink-0"
            >
              Copy
            </Button>
            <Button
              size="xs"
              variant="ghost"
              shape="square"
              className="shrink-0"
              aria-label="Dismiss"
              title="Dismiss"
              onClick={() => setLiveResult(null)}
            >
              <CloseIcon size={12} />
            </Button>
          </div>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="flex-1 overflow-y-auto nice-scroll">
          <div className="h-full flex items-center justify-center t-tertiary text-meta px-6 text-center">
            No translations yet. Type above, or enable auto-translate in Settings → Clipboard and copy foreign text.
          </div>
        </div>
      ) : (
        <>
          <div className="px-3 pt-3 pb-1 flex items-center justify-between shrink-0">
            <SectionLabel>History · {rows.length}</SectionLabel>
            <Button size="xs" variant="ghost" onClick={onClearAll}>
              Clear all
            </Button>
          </div>
          <TranslationHistory
            rows={rows}
            onCopy={onCopy}
            onDelete={onDelete}
            onSpeak={speak}
          />
        </>
      )}
      <ConfirmDialog
        open={clearOpen}
        title="Clear translations?"
        description="All translation history will be removed."
        confirmLabel="Clear"
        tone="danger"
        onConfirm={confirmClearAll}
        onCancel={() => setClearOpen(false)}
      />
    </div>
  );
};

interface HistoryProps {
  rows: TranslationRow[];
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
  onSpeak: (text: string, lang: string) => void;
}

/// Beyond this many history entries we switch to a virtualized scroller so
/// scrolling and typing stay smooth. Below the threshold we keep the plain
/// `.map` render so unit tests (jsdom can't measure layout) still see every
/// row, and small lists don't pay the virtualizer's setup cost.
const VIRTUALIZE_THRESHOLD = 40;

const TranslationHistory = ({ rows, onCopy, onDelete, onSpeak }: HistoryProps) => {
  if (rows.length < VIRTUALIZE_THRESHOLD) {
    return (
      <div className="flex-1 overflow-y-auto nice-scroll">
        {rows.map((row) => (
          <TranslationRowView
            key={row.id}
            row={row}
            onCopy={onCopy}
            onDelete={onDelete}
            onSpeak={onSpeak}
          />
        ))}
      </div>
    );
  }
  return <VirtualHistory rows={rows} onCopy={onCopy} onDelete={onDelete} onSpeak={onSpeak} />;
};

const VirtualHistory = ({ rows, onCopy, onDelete, onSpeak }: HistoryProps) => {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    // Rough estimate; measureElement refines per-row from real DOM height.
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
}

const rowStyle = {
  background: 'rgba(255,255,255,0.02)',
  border: '1px solid rgba(255,255,255,0.05)',
} as const;

const langPillStyle = {
  background: 'rgba(var(--stash-accent-rgb), 0.22)',
} as const;

/// Memoized so history rows don't re-render on every keystroke in the
/// translate textarea. Parent callbacks are stable (useCallback), and `row`
/// is reference-stable across reloads that don't touch that entry, so the
/// default shallow compare is enough.
const TranslationRowView = memo(({ row, onCopy, onDelete, onSpeak }: RowViewProps) => (
  <div
    className="mx-2 my-1 rounded-lg p-2.5 flex items-start gap-2"
    style={rowStyle}
  >
    <span
      className="px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wider t-primary shrink-0 uppercase"
      style={langPillStyle}
    >
      → {row.to_lang}
    </span>
    <div className="flex-1 min-w-0">
      <div className="t-primary text-body leading-snug break-words">
        {row.translated}
      </div>
      <div className="t-tertiary text-meta break-words mt-0.5">
        {row.original}
      </div>
      <div className="t-tertiary text-[10px] font-mono mt-1">
        {iso(row.created_at)}
      </div>
    </div>
    <Button
      size="xs"
      variant="ghost"
      onClick={() => onSpeak(row.translated, row.to_lang)}
      title="Speak"
      aria-label="Speak translation"
      className="shrink-0"
    >
      🔊
    </Button>
    <Button
      size="xs"
      variant="soft"
      onClick={() => onCopy(row.translated)}
      title="Copy translation"
      className="shrink-0"
    >
      Copy
    </Button>
    <Button
      size="xs"
      variant="ghost"
      tone="danger"
      shape="square"
      onClick={() => onDelete(row.id)}
      aria-label="Delete"
      title="Delete"
      className="shrink-0"
    >
      <CloseIcon size={12} />
    </Button>
  </div>
));
TranslationRowView.displayName = 'TranslationRowView';
