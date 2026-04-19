import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { modules } from '../modules/registry';
import { TabButton } from '../shared/ui/TabButton';
import { loadSettings } from '../settings/store';
import {
  pruneHistory,
  setCookiesBrowser,
  setDownloadsDir,
  setMaxParallel,
  setRateLimit,
} from '../modules/downloader/api';
import { setTranslatorSettings } from '../modules/translator/api';
import { Cheatsheet } from '../shared/ui/Cheatsheet';
import { GlobalSearch } from '../shared/ui/GlobalSearch';
import { TranslationBanner } from '../modules/clipboard/TranslationBanner';
import { applyTheme } from '../settings/theme';

export const PopupShell = () => {
  const [activeId, setActiveId] = useState(modules[0]?.id ?? '');
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [translation, setTranslation] = useState<null | {
    original: string;
    translated: string;
    to: string;
  }>(null);
  const active = modules.find((m) => m.id === activeId);
  const Popup = active?.PopupView;

  useEffect(() => {
    loadSettings()
      .then((s) => {
        applyTheme({
          mode: s.themeMode,
          blur: s.themeBlur,
          paneOpacity: s.themePaneOpacity,
          accent: s.themeAccent,
        });
        return Promise.all([
          setDownloadsDir(s.downloadsFolder),
          setCookiesBrowser(s.cookiesFromBrowser),
          setMaxParallel(s.maxParallelDownloads),
          setRateLimit(s.downloadRateLimit),
          pruneHistory(s.historyRetentionDays),
          setTranslatorSettings({
            enabled: s.translateEnabled,
            target: s.translateTarget,
            minChars: s.translateMinChars,
          }),
        ]);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typingInInput =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);
      if (e.key === 'Escape') {
        if (cheatsheetOpen) {
          setCheatsheetOpen(false);
          return;
        }
        getCurrentWindow()
          .hide()
          .catch(() => {});
        return;
      }
      // ⌘⌥1/2/3 switch modules (leaves ⌘1-4 free for clipboard filters)
      if (e.metaKey && e.altKey && /^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        if (modules[idx]) {
          e.preventDefault();
          setActiveId(modules[idx].id);
        }
        return;
      }
      // ? or ⌘/ opens the keyboard cheatsheet.
      if (!typingInInput && (e.key === '?' || (e.metaKey && e.key === '/'))) {
        e.preventDefault();
        setCheatsheetOpen((v) => !v);
      }
      // ⌘⇧F opens unified search across clipboard + downloads + notes.
      if (e.metaKey && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [cheatsheetOpen]);

  // Rust can ask us to activate a specific tab (e.g. ⌘⇧N opens Notes).
  useEffect(() => {
    const unlisten = listen<string>('nav:activate', (e) => {
      if (modules.some((m) => m.id === e.payload)) setActiveId(e.payload);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Global listener: translation banner lives at shell level so it renders
  // on every tab, regardless of which module is active when the translation
  // lands. We also unconditionally fire a native notification so the user
  // sees the result even while the popup is hidden.
  useEffect(() => {
    type Payload = {
      id: number;
      original: string;
      translated: string;
      from: string;
      to: string;
    };
    const unlisten = listen<Payload>('clipboard:translated', async (e) => {
      setTranslation({
        original: e.payload.original,
        translated: e.payload.translated,
        to: e.payload.to,
      });
      try {
        const s = await loadSettings();
        if (!s.translateShowNotification) return;
        const {
          isPermissionGranted,
          requestPermission,
          sendNotification,
        } = await import('@tauri-apps/plugin-notification');
        const granted =
          (await isPermissionGranted()) ||
          (await requestPermission()) === 'granted';
        if (granted) {
          sendNotification({
            title: `Translation → ${e.payload.to.toUpperCase()}`,
            body: e.payload.translated,
          });
        }
      } catch (err) {
        console.error('translate notify failed', err);
      }
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Auto-dismiss the banner after a comfortable read — but only if the user
  // hasn't dismissed it manually first. Resets on every new translation.
  useEffect(() => {
    if (!translation) return;
    const t = window.setTimeout(() => setTranslation(null), 12_000);
    return () => window.clearTimeout(t);
  }, [translation]);

  return (
    <div className="pane h-full w-full rounded-2xl overflow-hidden flex flex-col relative">
      <header className="flex items-center gap-1 px-2 py-1.5 border-b hair">
        {modules.map((m, i) => (
          <TabButton
            key={m.id}
            label={m.title}
            shortcutHint={`⌘⌥${i + 1}`}
            active={m.id === activeId}
            onClick={() => setActiveId(m.id)}
          />
        ))}
        <div className="ml-auto">
          <button
            onClick={() => setCheatsheetOpen(true)}
            className="t-tertiary hover:t-primary text-meta px-2 py-1 rounded"
            title="Shortcuts (?)"
            aria-label="Shortcuts"
          >
            ?
          </button>
        </div>
      </header>
      {translation && (
        <TranslationBanner
          original={translation.original}
          translated={translation.translated}
          to={translation.to}
          onDismiss={() => setTranslation(null)}
        />
      )}
      <main className="flex-1 overflow-hidden">
        {Popup ? <Popup /> : <div className="p-4 t-tertiary text-meta">No view.</div>}
      </main>
      <Cheatsheet
        open={cheatsheetOpen}
        onClose={() => setCheatsheetOpen(false)}
        tab={activeId}
      />
      <GlobalSearch
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onNavigate={(tab) => setActiveId(tab)}
      />
    </div>
  );
};
