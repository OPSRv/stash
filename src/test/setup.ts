import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue([]),
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn().mockResolvedValue('/test-app-data'),
  appLocalDataDir: vi.fn().mockResolvedValue('/test-app-local'),
  join: vi.fn(async (...parts: string[]) => parts.filter(Boolean).join('/')),
  resolve: vi.fn(async (...parts: string[]) => parts.filter(Boolean).join('/')),
  basename: vi.fn(async (p: string) => p.replace(/^.*[\\/]/, '')),
  dirname: vi.fn(async (p: string) => p.replace(/[\\/][^\\/]*$/, '')),
  sep: vi.fn().mockReturnValue('/'),
}));

// Event mock — remembers listeners per event name and exposes `__emit`
// so tests can drive UI paths that react to Tauri events without going
// through the real IPC. `listen` still returns an unsubscribe fn so
// existing test assertions keep working unchanged.
const __listeners = new Map<string, Set<(payload: unknown) => void>>();
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: (payload: { payload: unknown }) => void) => {
    const bag = __listeners.get(event) ?? new Set();
    const wrapped = (payload: unknown) => handler({ payload } as { payload: unknown });
    bag.add(wrapped);
    __listeners.set(event, bag);
    return () => {
      bag.delete(wrapped);
    };
  }),
  __emit: (event: string, payload: unknown) => {
    __listeners.get(event)?.forEach((fn) => fn(payload));
  },
}));

vi.mock('@tauri-apps/api/window', () => {
  const win = {
    hide: vi.fn().mockResolvedValue(undefined),
    setAlwaysOnTop: vi.fn().mockResolvedValue(undefined),
  };
  return { getCurrentWindow: () => win };
});

vi.mock('@tauri-apps/api/webview', () => {
  const webview = {
    onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
  };
  return { getCurrentWebview: () => webview };
});

vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    get = vi.fn().mockResolvedValue(undefined);
    set = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('@tauri-apps/plugin-autostart', () => ({
  enable: vi.fn().mockResolvedValue(undefined),
  disable: vi.fn().mockResolvedValue(undefined),
  isEnabled: vi.fn().mockResolvedValue(false),
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: vi.fn().mockResolvedValue(''),
  writeText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue('granted'),
  sendNotification: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
}));

// jsdom doesn't ship ResizeObserver; @tanstack/react-virtual uses it to react
// to scroll-element resizes. A stub is enough — tests render at fixed sizes.
class ResizeObserverStub {
  constructor(_cb: ResizeObserverCallback) {}
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

class IntersectionObserverStub {
  constructor(_cb: IntersectionObserverCallback) {}
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
if (typeof globalThis.IntersectionObserver === 'undefined') {
  globalThis.IntersectionObserver =
    IntersectionObserverStub as unknown as typeof IntersectionObserver;
}

// jsdom doesn't run layout, so HTMLElement.clientHeight/getBoundingClientRect
// return 0 — which makes @tanstack/react-virtual think the scroll container
// is empty and render nothing. Override the defaults so virtualised lists
// actually have a viewport in tests.
Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  get: () => 600,
});
Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get: () => 600,
});
HTMLElement.prototype.getBoundingClientRect = function () {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 600,
    bottom: 600,
    width: 600,
    height: 600,
    toJSON: () => ({}),
  } as DOMRect;
};

afterEach(() => {
  cleanup();
});
