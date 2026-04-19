import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./api', () => ({
  musicStatus: vi.fn().mockResolvedValue({ attached: false, visible: false }),
  musicEmbed: vi.fn().mockResolvedValue(undefined),
  musicHide: vi.fn().mockResolvedValue(undefined),
  musicShow: vi.fn().mockResolvedValue(undefined),
  musicClose: vi.fn().mockResolvedValue(undefined),
  musicReload: vi.fn().mockResolvedValue(undefined),
}));

import { MusicShell } from './MusicShell';
import { musicHide } from './api';

// Capture the IntersectionObserver callback so tests can simulate visibility
// flips (PopupShell toggles the `hidden` ancestor on tab switch; jsdom's stub
// doesn't actually fire the callback).
let ioCallback: IntersectionObserverCallback | null = null;
class CapturingIO {
  constructor(cb: IntersectionObserverCallback) {
    ioCallback = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
  root = null;
  rootMargin = '';
  thresholds = [];
}

describe('MusicShell', () => {
  beforeEach(() => {
    ioCallback = null;
    globalThis.IntersectionObserver =
      CapturingIO as unknown as typeof IntersectionObserver;
    vi.clearAllMocks();
  });

  it('hides the native webview when the tab becomes non-visible', async () => {
    render(<MusicShell />);
    // Flush microtasks so the effect + observer has run.
    await Promise.resolve();
    expect(ioCallback).not.toBeNull();
    ioCallback!(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    expect(musicHide).toHaveBeenCalled();
  });
});
