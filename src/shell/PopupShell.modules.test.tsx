import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Override the default plugin-store mock so this file can dictate what
// `loadSettings()` returns. The shared setup.ts mock just hands back
// `undefined` for every key, which always resolves to DEFAULT_SETTINGS.
const storeMocks = vi.hoisted(() => {
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
    get = storeMocks.get;
    set = storeMocks.set;
  },
}));

import { PopupShell } from './PopupShell';
import { invalidateSettingsCache } from '../settings/store';

describe('PopupShell — module visibility & order', () => {
  beforeEach(() => {
    storeMocks.stored.clear();
    storeMocks.get.mockClear();
    storeMocks.set.mockClear();
    invalidateSettingsCache();
  });

  afterEach(() => {
    storeMocks.stored.clear();
    invalidateSettingsCache();
  });

  it('hides tabs listed in hiddenModules', async () => {
    storeMocks.stored.set('hiddenModules', ['metronome', 'separator']);
    render(<PopupShell />);
    await screen.findByRole('searchbox', undefined, { timeout: 8000 });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Metronome/ })).toBeNull();
    });
    expect(screen.queryByRole('button', { name: /^Separator/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Clipboard/ })).toBeInTheDocument();
    // Settings is always present and last.
    expect(screen.getByRole('button', { name: /^Settings/ })).toBeInTheDocument();
  });

  it('renders tabs in the user-defined order', async () => {
    storeMocks.stored.set('moduleOrder', ['notes', 'clipboard']);
    render(<PopupShell />);
    await screen.findByRole('searchbox', undefined, { timeout: 8000 });
    await waitFor(() => {
      // Native <button>s have implicit role="button" but no role attribute,
      // so we walk by tag and filter by aria-label.
      const labels = Array.from(
        document.querySelectorAll<HTMLButtonElement>('header button[aria-label]'),
      ).map((el) => el.getAttribute('aria-label') ?? '');
      const idxNotes = labels.findIndex((l) => /^Notes$/i.test(l));
      const idxClipboard = labels.findIndex((l) => /^Clipboard$/i.test(l));
      expect(idxNotes).toBeGreaterThanOrEqual(0);
      expect(idxClipboard).toBeGreaterThan(idxNotes);
    });
  });

  it('falls back to the first visible tab when the active id was hidden', async () => {
    // Hide Clipboard (the registry-default first tab) — PopupShell should
    // jump to the next visible module on settings load.
    storeMocks.stored.set('hiddenModules', ['clipboard']);
    render(<PopupShell />);
    // Downloader popup renders an "Add to queue"-type input distinct from
    // the clipboard searchbox; rely on tab presence instead so we don't
    // couple to a specific module's UI.
    await waitFor(
      () => {
        expect(screen.queryByRole('button', { name: /^Clipboard/ })).toBeNull();
        expect(
          screen.getByRole('button', { name: /^Downloads/ }),
        ).toBeInTheDocument();
      },
      { timeout: 8000 },
    );
  });

  it('reacts to live stash:settings-changed for hiddenModules', async () => {
    const user = userEvent.setup();
    render(<PopupShell />);
    await screen.findByRole('searchbox', undefined, { timeout: 8000 });
    expect(screen.getByRole('button', { name: /^Metronome/ })).toBeInTheDocument();

    // Simulate the Modules tab persisting a new value and broadcasting.
    storeMocks.stored.set('hiddenModules', ['metronome']);
    invalidateSettingsCache();
    await user.click(document.body); // realistic event ordering before dispatch
    window.dispatchEvent(
      new CustomEvent('stash:settings-changed', { detail: 'hiddenModules' }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Metronome/ })).toBeNull();
    });
  });
});
