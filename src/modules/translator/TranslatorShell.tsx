import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { SectionLabel } from '../../shared/ui/SectionLabel';
import { CloseIcon } from '../../shared/ui/icons';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { Select } from '../../shared/ui/Select';
import { Spinner } from '../../shared/ui/Spinner';
import { Button } from '../../shared/ui/Button';
import { useToast } from '../../shared/ui/Toast';
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
    [toast],
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
            <button
              onClick={() => onCopy(liveResult.translated)}
              className="t-secondary hover:t-primary text-meta px-2 py-0.5 rounded shrink-0"
              style={{ background: 'rgba(255,255,255,0.06)' }}
              title="Copy translation"
            >
              Copy
            </button>
            <button
              onClick={() => setLiveResult(null)}
              className="t-tertiary hover:t-primary p-1 shrink-0"
              aria-label="Dismiss"
            >
              <CloseIcon size={12} />
            </button>
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto nice-scroll">
        {rows.length === 0 && (
          <div className="h-full flex items-center justify-center t-tertiary text-meta px-6 text-center">
            No translations yet. Type above, or enable auto-translate in Settings → Clipboard and copy foreign text.
          </div>
        )}
        {rows.length > 0 && (
          <>
            <div className="px-3 pt-3 pb-1 flex items-center justify-between">
              <SectionLabel>History · {rows.length}</SectionLabel>
              <button
                onClick={onClearAll}
                className="t-tertiary text-meta hover:t-secondary"
              >
                Clear all
              </button>
            </div>
            {rows.map((row) => (
              <TranslationRowView
                key={row.id}
                row={row}
                onCopy={onCopy}
                onDelete={onDelete}
              />
            ))}
          </>
        )}
      </div>
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

interface RowViewProps {
  row: TranslationRow;
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
}

const rowStyle = {
  background: 'rgba(255,255,255,0.02)',
  border: '1px solid rgba(255,255,255,0.05)',
} as const;

const langPillStyle = {
  background: 'rgba(var(--stash-accent-rgb), 0.22)',
} as const;

const copyButtonStyle = { background: 'rgba(255,255,255,0.06)' } as const;

const TranslationRowView = ({ row, onCopy, onDelete }: RowViewProps) => (
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
    <button
      onClick={() => onCopy(row.translated)}
      className="t-secondary hover:t-primary text-meta px-2 py-0.5 rounded shrink-0"
      style={copyButtonStyle}
      title="Copy translation"
    >
      Copy
    </button>
    <button
      onClick={() => onDelete(row.id)}
      className="t-tertiary hover:text-red-400 p-1 shrink-0"
      aria-label="Delete"
    >
      <CloseIcon size={12} />
    </button>
  </div>
);
