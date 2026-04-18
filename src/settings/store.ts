import { LazyStore } from '@tauri-apps/plugin-store';

export type Settings = {
  maxHistoryItems: number;
  launchAtLogin: boolean;
  downloadsFolder: string | null;
  notifyOnDownloadComplete: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  maxHistoryItems: 1000,
  launchAtLogin: false,
  downloadsFolder: null,
  notifyOnDownloadComplete: true,
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
