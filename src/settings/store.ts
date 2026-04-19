import { LazyStore } from '@tauri-apps/plugin-store';
import { DEFAULT_THEME, type AccentKey, type ThemeMode } from './theme';

export type CookiesBrowser =
  | 'safari'
  | 'chrome'
  | 'firefox'
  | 'edge'
  | 'brave'
  | 'vivaldi'
  | 'chromium'
  | 'arc'
  | null;

export type Settings = {
  maxHistoryItems: number;
  launchAtLogin: boolean;
  downloadsFolder: string | null;
  notifyOnDownloadComplete: boolean;
  cookiesFromBrowser: CookiesBrowser;
  maxParallelDownloads: number;
  downloadRateLimit: string | null;
  historyRetentionDays: number;
  themeMode: ThemeMode;
  themeBlur: number;
  themePaneOpacity: number;
  themeAccent: AccentKey;
  translateEnabled: boolean;
  translateTarget: string;
  translateMinChars: number;
  translateShowNotification: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  maxHistoryItems: 1000,
  launchAtLogin: false,
  downloadsFolder: null,
  notifyOnDownloadComplete: true,
  cookiesFromBrowser: null,
  maxParallelDownloads: 3,
  downloadRateLimit: null,
  historyRetentionDays: 60,
  themeMode: DEFAULT_THEME.mode,
  themeBlur: DEFAULT_THEME.blur,
  themePaneOpacity: DEFAULT_THEME.paneOpacity,
  themeAccent: DEFAULT_THEME.accent,
  translateEnabled: false,
  translateTarget: 'uk',
  translateMinChars: 6,
  translateShowNotification: true,
};

const store = new LazyStore('settings.json', { autoSave: true, defaults: DEFAULT_SETTINGS });

export const loadSettings = async (): Promise<Settings> => {
  const keys = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];
  const entries = await Promise.all(
    keys.map(async (k) => {
      const v = await store.get<Settings[typeof k]>(k);
      return [k, v ?? DEFAULT_SETTINGS[k]] as const;
    })
  );
  return Object.fromEntries(entries) as Settings;
};

export const saveSetting = async <K extends keyof Settings>(
  key: K,
  value: Settings[K]
): Promise<void> => {
  await store.set(key, value);
};
