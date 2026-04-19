import { beforeEach, describe, expect, it, vi } from 'vitest';

// Override the default plugin-store mock so we can observe get/set calls.
const mocks = vi.hoisted(() => {
  const stored = new Map<string, unknown>();
  return {
    stored,
    get: vi.fn(async (k: string) => stored.get(k)),
    set: vi.fn(async (k: string, v: unknown) => {
      stored.set(k, v);
    }),
  };
});

vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    get = mocks.get;
    set = mocks.set;
  },
}));

import { DEFAULT_SETTINGS, loadSettings, saveSetting } from './store';

describe('settings/store', () => {
  beforeEach(() => {
    mocks.stored.clear();
    mocks.get.mockClear();
    mocks.set.mockClear();
  });

  it('loadSettings returns defaults when the store is empty', async () => {
    const s = await loadSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it('loadSettings merges stored values over defaults', async () => {
    mocks.stored.set('themeBlur', 44);
    mocks.stored.set('launchAtLogin', true);
    mocks.stored.set('translateTarget', 'de');
    const s = await loadSettings();
    expect(s.themeBlur).toBe(44);
    expect(s.launchAtLogin).toBe(true);
    expect(s.translateTarget).toBe('de');
    // Untouched keys stay on defaults.
    expect(s.maxHistoryItems).toBe(DEFAULT_SETTINGS.maxHistoryItems);
  });

  it('saveSetting forwards to the store', async () => {
    await saveSetting('themeMode', 'light');
    expect(mocks.set).toHaveBeenCalledWith('themeMode', 'light');
  });
});
