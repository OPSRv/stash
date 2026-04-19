import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
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
import { TerminalTab } from './TerminalTab';
import { DEFAULT_SETTINGS, loadSettings, saveSetting, type Settings } from './store';
import { applyTheme, broadcastTheme } from './theme';

type Tab =
  | 'general'
  | 'appearance'
  | 'clipboard'
  | 'downloads'
  | 'terminal'
  | 'ai'
  | 'about';

const tabs: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'clipboard', label: 'Clipboard' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'ai', label: 'AI' },
  { id: 'about', label: 'About' },
];

/// Settings root: owns the active-tab state + the settings-update effect
/// bus that pushes changes to Rust-side state (downloads dir, cookies,
/// translator, autostart). Rendering is delegated to one tab component
/// per file.
export const SettingsShell = () => {
  const [tab, setTab] = useState<Tab>('general');
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [autostartOn, setAutostartOn] = useState(false);

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
    <div className="h-full flex flex-col">
      <nav className="px-4 py-2 flex items-center gap-1 border-b hair" role="tablist">
        {tabs.map((t) => {
          const isActive = tab === t.id;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 rounded-md text-body font-medium transition-colors cursor-pointer ${
                isActive ? 't-primary bg-white/[0.06]' : 't-secondary hover:bg-white/[0.04]'
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </nav>
      <main className="flex-1 overflow-y-auto nice-scroll px-6 py-5">
        {tab === 'general' && (
          <GeneralTab autostartOn={autostartOn} onToggleAutostart={toggleAutostart} />
        )}
        {tab === 'appearance' && <AppearanceTab settings={settings} onChange={update} />}
        {tab === 'clipboard' && <ClipboardTab settings={settings} onChange={update} />}
        {tab === 'downloads' && <DownloadsTab settings={settings} onChange={update} />}
        {tab === 'terminal' && <TerminalTab settings={settings} onChange={update} />}
        {tab === 'ai' && <AiTab settings={settings} onChange={update} />}
        {tab === 'about' && <AboutTab />}
      </main>
    </div>
  );
};
