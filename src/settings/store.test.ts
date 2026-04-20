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

import { DEFAULT_SETTINGS, invalidateSettingsCache, loadSettings, saveSetting } from './store';

describe('settings/store', () => {
  beforeEach(() => {
    mocks.stored.clear();
    mocks.get.mockClear();
    mocks.set.mockClear();
    // Production `loadSettings` caches the first successful read in memory.
    // Tests mutate the backing Map directly between cases, so we have to
    // drop the cache or each test would see the prior test's snapshot.
    invalidateSettingsCache();
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

  it('loadSettings caches across calls so a second read skips disk I/O', async () => {
    mocks.stored.set('themeBlur', 42);
    await loadSettings();
    const callsAfterFirst = mocks.get.mock.calls.length;
    // Mutate the backing store; with a cache, the second call must return
    // the pre-cached value rather than re-reading.
    mocks.stored.set('themeBlur', 99);
    const s2 = await loadSettings();
    expect(s2.themeBlur).toBe(42);
    expect(mocks.get.mock.calls.length).toBe(callsAfterFirst);
  });

  it('concurrent loadSettings calls share one in-flight read', async () => {
    const [a, b] = await Promise.all([loadSettings(), loadSettings()]);
    expect(a).toEqual(b);
    // One pass of `get(k)` per settings key — never twice.
    expect(mocks.get.mock.calls.length).toBe(Object.keys(DEFAULT_SETTINGS).length);
  });

  it('saveSetting updates the cache so subsequent reads see the new value', async () => {
    await loadSettings();
    await saveSetting('themeBlur', 77);
    const s = await loadSettings();
    expect(s.themeBlur).toBe(77);
  });
});
