import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { WebChatService } from '../../settings/store';
import { ToastProvider } from '../../shared/ui/Toast';

let mockServices: WebChatService[] = [];

// Stub the list hook and the native-webview bridge so the test is a pure
// React exercise — no settings.json, no invoke.
vi.mock('./useWebServices', () => ({
  useWebServices: (): WebChatService[] => mockServices,
}));

vi.mock('./webchatApi', () => ({
  faviconUrlFor: () => '',
  webchatClose: vi.fn().mockResolvedValue(undefined),
  webchatHideAll: vi.fn().mockResolvedValue(undefined),
  webchatHide: vi.fn().mockResolvedValue(undefined),
  webchatEmbed: vi.fn().mockResolvedValue(undefined),
  webchatReload: vi.fn().mockResolvedValue(undefined),
  webchatBack: vi.fn().mockResolvedValue(undefined),
  webchatForward: vi.fn().mockResolvedValue(undefined),
  webchatCurrentUrl: vi.fn().mockResolvedValue(''),
  webchatSetZoom: vi.fn().mockResolvedValue(undefined),
}));

// openUrl isn't in the global mock — stub it here so the module imports cleanly.
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));

// Imported *after* the mocks so the hook/api stubs take effect.
import { WebShell } from './WebShell';

const renderShell = () =>
  render(
    <ToastProvider>
      <WebShell />
    </ToastProvider>,
  );

beforeEach(() => {
  // Reset only the keys WebShell owns — jsdom's Storage.clear is flaky
  // across environments, and we don't want to wipe unrelated keys anyway.
  try {
    localStorage.removeItem('stash.web.lastTab');
    localStorage.removeItem('stash.web.collapsed');
    localStorage.removeItem('stash.web.lastUsed');
  } catch {
    // ignore
  }
  mockServices = [
    { id: 'chatgpt', label: 'ChatGPT', url: 'https://chat.openai.com' },
    { id: 'gemini', label: 'Gemini', url: 'https://gemini.google.com/app' },
  ];
});

describe('WebShell (Arc-style sidebar)', () => {
  test('renders Home and each service as a tab in the unpinned section', () => {
    renderShell();
    const unpinned = screen.getByRole('tablist', { name: 'Unpinned tabs' });
    expect(within(unpinned).getByRole('tab', { name: 'ChatGPT' })).toBeInTheDocument();
    expect(within(unpinned).getByRole('tab', { name: 'Gemini' })).toBeInTheDocument();
    expect(within(unpinned).getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByRole('tab', { name: 'Home' })).toBeInTheDocument();
  });

  test('Home is selected by default and shows the tile grid', () => {
    renderShell();
    const home = screen.getByRole('tab', { name: 'Home' });
    expect(home).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getByRole('button', { name: /ChatGPT.*chat\.openai\.com/s }),
    ).toBeInTheDocument();
  });

  test('sidebar exposes Add-tab, Collapse, and per-service close buttons', () => {
    renderShell();
    expect(screen.getByRole('button', { name: 'Add web tab' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close ChatGPT' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close Gemini' })).toBeInTheDocument();
  });

  test('Collapse button hides labels and shrinks the sidebar', () => {
    renderShell();
    const collapseBtn = screen.getByRole('button', { name: 'Collapse sidebar' });
    fireEvent.click(collapseBtn);
    // The close buttons and the "ChatGPT" visible text disappear when
    // collapsed — the label is moved to the aria-label of the tab itself.
    expect(screen.queryByRole('button', { name: 'Close ChatGPT' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'ChatGPT' })).toBeInTheDocument();
  });

  test('splits pinned and unpinned services into separate sections', () => {
    mockServices = [
      { id: 'a', label: 'A', url: 'https://a.example', pinned: true },
      { id: 'b', label: 'B', url: 'https://b.example' },
    ];
    renderShell();
    const pinned = screen.getByRole('tablist', { name: 'Pinned tabs' });
    expect(within(pinned).getByRole('tab', { name: 'A' })).toBeInTheDocument();
    const unpinned = screen.getByRole('tablist', { name: 'Unpinned tabs' });
    expect(within(unpinned).getByRole('tab', { name: 'B' })).toBeInTheDocument();
  });

  test('right-click on a tab opens the context menu with expected items', () => {
    renderShell();
    const chatgpt = screen.getByRole('tab', { name: 'ChatGPT' });
    fireEvent.contextMenu(chatgpt);
    const menu = screen.getByRole('menu', { name: 'Actions for ChatGPT' });
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((b) => b.textContent?.trim());
    expect(items).toEqual([
      'Rename',
      'Duplicate',
      'Pin',
      'Copy URL',
      'Close (free RAM)',
      'Close others',
      'Delete tab',
    ]);
  });

  test('context menu shows Unpin for a pinned tab', () => {
    mockServices = [{ id: 'a', label: 'A', url: 'https://a.example', pinned: true }];
    renderShell();
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'A' }));
    expect(screen.getByRole('menuitem', { name: 'Unpin' })).toBeInTheDocument();
  });
});
