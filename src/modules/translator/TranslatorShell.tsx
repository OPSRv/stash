import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { useToast } from '../../shared/ui/Toast';
import { useAnnounce } from '../../shared/ui/LiveRegion';
import { useSuppressibleConfirm } from '../../shared/hooks/useSuppressibleConfirm';
import { loadSettings, saveSetting } from '../../settings/store';
import { TranslatorComposer } from './TranslatorComposer';
import { TranslatorHistoryPanel } from './TranslatorHistoryPanel';
import { TARGET_LANGUAGES, languageLabel } from './languages';
import { useAutoTranslate } from './useAutoTranslate';
import { useHistorySearch } from './useHistorySearch';
import { useTranslatorHotkeys } from './useTranslatorHotkeys';
import {
  translate,
  translatorClear,
  translatorDelete,
  type TranslationRow,
} from './api';

interface LiveResult {
  original: string;
  translated: string;
  from: string;
  to: string;
}

/// Top-level Translator module. Owns the state machine (draft, target,
/// detection, live-result) and wires the composer and history panel
/// to their shared callbacks. Rendering and hotkey plumbing live in
/// their own files.
export const TranslatorShell = () => {
  const [rows, setRows] = useState<TranslationRow[]>([]);
  const [isClearOpen, setIsClearOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [sourceHint, setSourceHint] = useState<string | null>(null);
  const [target, setTarget] = useState('en');
  const [isBusy, setIsBusy] = useState(false);
  const [liveResult, setLiveResult] = useState<LiveResult | null>(null);
  const [historyQuery, setHistoryQuery] = useState('');
  const sourceRef = useRef<HTMLTextAreaElement | null>(null);
  const { toast } = useToast();
  const { announce } = useAnnounce();
  const deleteConfirm = useSuppressibleConfirm<number>('translator.delete');

  useEffect(() => {
    loadSettings()
      .then((settings) => setTarget(settings.translateTarget || 'en'))
      .catch(() => {});
  }, []);

  const runTranslate = useCallback(
    async (rawText: string, to: string, from?: string) => {
      const text = rawText.trim();
      if (!text) return;
      setIsBusy(true);
      try {
        const result = await translate(text, to, from);
        setLiveResult({
          original: result.original,
          translated: result.translated,
          from: result.from,
          to: result.to,
        });
        announce('Translation ready');
      } catch (error) {
        console.error('manual translate failed', error);
        toast({
          title: 'Translate failed',
          description: String(error),
          variant: 'error',
          action: { label: 'Retry', onClick: () => void runTranslate(text, to, from) },
        });
      } finally {
        setIsBusy(false);
      }
    },
    [toast, announce],
  );

  const handleAutoEmpty = useCallback(() => {
    setLiveResult(null);
  }, []);

  useAutoTranslate({
    draft,
    target,
    sourceHint,
    onTranslate: runTranslate,
    onEmpty: handleAutoEmpty,
  });

  useHistorySearch({ query: historyQuery, onResults: setRows });

  // Refresh the list whenever a new auto-translation lands, unless the
  // user is actively filtering — we don't want the list to shift under
  // their typed query mid-search.
  useEffect(() => {
    const unlisten = listen('clipboard:translated', () => {
      if (historyQuery.trim()) return;
      // Empty query → useHistorySearch already listens for the query-string;
      // trigger its refresh by temporarily flipping state. Simplest path:
      // re-fetch through the hook contract.
      setHistoryQuery('');
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [historyQuery]);

  const handleTargetChange = useCallback((next: string) => {
    setTarget(next);
    saveSetting('translateTarget', next).catch(() => {});
  }, []);

  const detectedFrom = liveResult?.from ?? null;
  const canSwap =
    detectedFrom != null &&
    detectedFrom !== 'auto' &&
    detectedFrom !== target &&
    TARGET_LANGUAGES.some((l) => l.code === detectedFrom);

  const handleSwap = useCallback(() => {
    if (!liveResult || !canSwap) return;
    const nextTarget = liveResult.from;
    const nextDraft = liveResult.translated;
    setTarget(nextTarget);
    saveSetting('translateTarget', nextTarget).catch(() => {});
    setDraft(nextDraft);
    setLiveResult(null);
    setSourceHint(null);
    announce(
      `Swapped — translating ${languageLabel(liveResult.to)} to ${languageLabel(nextTarget)}`,
    );
  }, [liveResult, canSwap, announce]);

  const handleSpeak = useCallback((text: string, lang: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang === 'auto' ? 'en' : lang;
    window.speechSynthesis.speak(utterance);
  }, []);

  const handleCopy = useCallback(
    async (text: string) => {
      try {
        await writeText(text);
        announce('Copied');
        toast({ title: 'Copied', variant: 'success', durationMs: 2000 });
      } catch (error) {
        console.error('copy failed', error);
        toast({ title: 'Copy failed', description: String(error), variant: 'error' });
      }
    },
    [toast, announce],
  );

  const performDelete = useCallback(
    async (id: number) => {
      try {
        await translatorDelete(id);
        announce('Translation deleted');
        setHistoryQuery((q) => q); // trigger useHistorySearch refresh
      } catch (error) {
        console.error('delete failed', error);
      }
    },
    [announce],
  );

  const handleDelete = useCallback(
    (id: number) => deleteConfirm.request(id, performDelete),
    [deleteConfirm, performDelete],
  );

  const handleReuse = useCallback((row: TranslationRow) => {
    setDraft(row.translated);
    setSourceHint(row.to_lang);
    setLiveResult(null);
    sourceRef.current?.focus();
  }, []);

  const handleDraftChange = useCallback((next: string) => {
    setSourceHint(null);
    setDraft(next);
  }, []);

  const handleClearDraft = useCallback(() => {
    setDraft('');
    setLiveResult(null);
    setSourceHint(null);
    sourceRef.current?.focus();
  }, []);

  const handleClearAll = useCallback(() => setIsClearOpen(true), []);

  const confirmClearAll = useCallback(async () => {
    setIsClearOpen(false);
    try {
      await translatorClear();
      announce('History cleared');
      toast({ title: 'Translations cleared', variant: 'success' });
      setHistoryQuery(''); // trigger list refetch
    } catch (error) {
      console.error('clear failed', error);
      toast({ title: 'Clear failed', description: String(error), variant: 'error' });
    }
  }, [toast, announce]);

  const handleTranslateNow = useCallback(() => {
    void runTranslate(draft, target, sourceHint ?? undefined);
  }, [runTranslate, draft, target, sourceHint]);

  useTranslatorHotkeys({
    sourceRef,
    canSwap,
    hasDraft: draft.length > 0,
    onSwap: handleSwap,
    onClearDraft: handleClearDraft,
  });

  return (
    <div className="h-full flex flex-col">
      <TranslatorComposer
        sourceRef={sourceRef}
        draft={draft}
        onDraftChange={handleDraftChange}
        target={target}
        onTargetChange={handleTargetChange}
        sourceHint={sourceHint}
        detectedFrom={detectedFrom}
        liveTranslation={liveResult?.translated ?? null}
        liveTo={liveResult?.to ?? null}
        isBusy={isBusy}
        canSwap={canSwap}
        onSwap={handleSwap}
        onClearDraft={handleClearDraft}
        onCopy={handleCopy}
        onSpeak={handleSpeak}
        onTranslateNow={handleTranslateNow}
      />

      <TranslatorHistoryPanel
        rows={rows}
        query={historyQuery}
        onQueryChange={setHistoryQuery}
        onCopy={handleCopy}
        onDelete={handleDelete}
        onSpeak={handleSpeak}
        onReuse={handleReuse}
        onClearAll={handleClearAll}
      />

      <ConfirmDialog
        open={isClearOpen}
        title="Clear translations?"
        description="All translation history will be removed."
        confirmLabel="Clear"
        tone="danger"
        onConfirm={confirmClearAll}
        onCancel={() => setIsClearOpen(false)}
      />
      <ConfirmDialog
        open={deleteConfirm.open}
        title="Delete this translation?"
        description="The entry will be removed from history."
        confirmLabel="Delete"
        tone="danger"
        suppressibleLabel="Don't ask again"
        onConfirm={(suppress) => deleteConfirm.confirm(Boolean(suppress))}
        onCancel={deleteConfirm.cancel}
      />
    </div>
  );
};
