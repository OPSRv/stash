import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
import { Button } from '../shared/ui/Button';
import {
  setCookiesBrowser,
  setDownloadsDir,
  setMaxParallel,
  setRateLimit,
} from '../modules/downloader/api';
import { setTranslatorSettings } from '../modules/translator/api';
import { AboutTab } from './AboutTab';
import { AiTab } from './AiTab';
import { AppearanceTab } from './AppearanceTab';
import { ClipboardTab } from './ClipboardTab';
import { DownloadsTab } from './DownloadsTab';
import { GeneralTab } from './GeneralTab';
import { NotesTab } from './NotesTab';
import { TelegramTab } from './TelegramTab';
import { TerminalTab } from './TerminalTab';
import { WebTab } from './WebTab';
import { DEFAULT_SETTINGS, loadSettings, saveSetting, type Settings } from './store';
import { applyTheme, broadcastTheme } from './theme';

type Tab =
  | 'general'
  | 'appearance'
  | 'clipboard'
  | 'downloads'
  | 'terminal'
  | 'notes'
  | 'ai'
  | 'web'
  | 'telegram'
  | 'about';

const Stroke = ({ d }: { d: string }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d={d} />
  </svg>
);

const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
  {
    id: 'general',
    label: 'General',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
      </svg>
    ),
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
        <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
        <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
        <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
        <path d="M12 22a10 10 0 1 1 0-20c5.523 0 10 4.03 10 9 0 1.657-1.343 3-3 3h-1.667A1.333 1.333 0 0 0 16 15.333c0 .369.146.71.402.954.256.244.402.585.402.953 0 .885-.717 1.76-1.604 1.76H12z" />
      </svg>
    ),
  },
  {
    id: 'clipboard',
    label: 'Clipboard',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="8" y="2" width="8" height="4" rx="1" />
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      </svg>
    ),
  },
  {
    id: 'downloads',
    label: 'Downloads',
    icon: <Stroke d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" />,
  },
  {
    id: 'terminal',
    label: 'Terminal',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <polyline points="4 7 9 12 4 17" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    ),
  },
  {
    id: 'notes',
    label: 'Notes',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 4h12l4 4v12a2 2 0 0 1-2 2H4z" />
        <path d="M16 4v4h4" />
        <path d="M8 12h8M8 16h6" />
      </svg>
    ),
  },
  {
    id: 'ai',
    label: 'AI',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 2 L15 9 L22 12 L15 15 L12 22 L9 15 L2 12 L9 9 Z" />
      </svg>
    ),
  },
  {
    id: 'web',
    label: 'Web',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
      </svg>
    ),
  },
  {
    id: 'telegram',
    label: 'Telegram',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M21.5 4.5 2.5 11.5l6 2m13-9-10 14-3-5m13-9-10 7" />
      </svg>
    ),
  },
  {
    id: 'about',
    label: 'About',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 16v-4M12 8h.01" />
      </svg>
    ),
  },
];

/// Settings root: owns the active-tab state + the settings-update effect
/// bus that pushes changes to Rust-side state (downloads dir, cookies,
/// translator, autostart). Rendering is delegated to one tab component
/// per file.
export const SettingsShell = () => {
  const [tab, setTab] = useState<Tab>('general');
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [autostartOn, setAutostartOn] = useState(false);

  // Cross-tab deep-link: other modules can dispatch
  // `stash:settings-section` with a Tab id to scroll users straight to
  // the right section after the Settings popup mounts. Used by the
  // Telegram Inbox gear so clicking ⚙ jumps to Settings → Telegram.
  useEffect(() => {
    const onSection = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (!detail) return;
      if (tabs.some((t) => t.id === detail)) {
        setTab(detail as Tab);
      }
    };
    window.addEventListener('stash:settings-section', onSection);
    return () => window.removeEventListener('stash:settings-section', onSection);
  }, []);

  useEffect(() => {
    loadSettings()
      .then((s) => {
        setSettings(s);
        applyTheme({
          mode: s.themeMode,
          blur: s.themeBlur,
          paneOpacity: s.themePaneOpacity,
          accent: s.themeAccent,
        });
      })
      .catch(console.error);
    isEnabled().then(setAutostartOn).catch(console.error);
  }, []);

  const update = async <K extends keyof Settings>(key: K, value: Settings[K]) => {
    const nextSettings = { ...settings, [key]: value };
    setSettings(nextSettings);
    await saveSetting(key, value).catch(console.error);
    if (
      key === 'themeMode' ||
      key === 'themeBlur' ||
      key === 'themePaneOpacity' ||
      key === 'themeAccent'
    ) {
      const theme = {
        mode: nextSettings.themeMode,
        blur: nextSettings.themeBlur,
        paneOpacity: nextSettings.themePaneOpacity,
        accent: nextSettings.themeAccent,
      };
      applyTheme(theme);
      broadcastTheme(theme);
    }
    if (key === 'downloadsFolder') {
      await setDownloadsDir(value as string | null).catch(console.error);
    }
    if (key === 'cookiesFromBrowser') {
      await setCookiesBrowser(value as string | null).catch(console.error);
      // Destroy the embedded Music webview so next open rebuilds it with
      // the UA derived from the new browser choice.
      await invoke('music_close').catch(() => {});
    }
    if (key === 'maxParallelDownloads') {
      await setMaxParallel(value as number).catch(console.error);
    }
    if (key === 'downloadRateLimit') {
      await setRateLimit(value as string | null).catch(console.error);
    }
    if (
      key === 'translateEnabled' ||
      key === 'translateTarget' ||
      key === 'translateMinChars'
    ) {
      await setTranslatorSettings({
        enabled: nextSettings.translateEnabled,
        target: nextSettings.translateTarget,
        minChars: nextSettings.translateMinChars,
      }).catch(console.error);
    }
    // Broadcast so modules subscribed via useAiSettings / similar hooks
    // re-read without a popup reload. Keyed by setting name in `detail`.
    window.dispatchEvent(
      new CustomEvent('stash:settings-changed', { detail: key }),
    );
  };

  const toggleAutostart = async (next: boolean) => {
    setAutostartOn(next);
    try {
      if (next) await enable();
      else await disable();
    } catch (error) {
      console.error('autostart toggle failed', error);
    }
    await update('launchAtLogin', next);
  };

  return (
    <div className="h-full flex">
      <nav
        className="w-[140px] shrink-0 px-2 py-3 flex flex-col gap-0.5 border-r hair"
        role="tablist"
        aria-orientation="vertical"
      >
        {tabs.map((t) => {
          const isActive = tab === t.id;
          return (
            <Button
              key={t.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => setTab(t.id)}
              size="sm"
              variant="ghost"
              fullWidth
              className={`!justify-start gap-2 text-meta font-medium cursor-pointer ${
                isActive ? 't-primary !bg-white/[0.06]' : 't-secondary'
              }`}
              leadingIcon={t.icon}
            >
              {t.label}
            </Button>
          );
        })}
      </nav>
      <main
        className="flex-1 min-w-0 overflow-y-auto nice-scroll px-6 py-5"
        style={{ scrollbarGutter: 'stable' }}
      >
        {tab === 'general' && (
          <GeneralTab autostartOn={autostartOn} onToggleAutostart={toggleAutostart} />
        )}
        {tab === 'appearance' && <AppearanceTab settings={settings} onChange={update} />}
        {tab === 'clipboard' && <ClipboardTab settings={settings} onChange={update} />}
        {tab === 'downloads' && <DownloadsTab settings={settings} onChange={update} />}
        {tab === 'terminal' && <TerminalTab settings={settings} onChange={update} />}
        {tab === 'notes' && (
          <NotesTab
            autoTranscribe={settings.notesAutoTranscribe}
            autoPolish={settings.notesAutoPolish}
            onToggleAutoTranscribe={(v) => update('notesAutoTranscribe', v)}
            onToggleAutoPolish={(v) => update('notesAutoPolish', v)}
          />
        )}
        {tab === 'ai' && <AiTab settings={settings} onChange={update} />}
        {tab === 'web' && <WebTab settings={settings} onChange={update} />}
        {tab === 'telegram' && <TelegramTab />}
        {tab === 'about' && <AboutTab />}
      </main>
    </div>
  );
};
