import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { PopupShell } from './PopupShell';

describe('PopupShell', () => {
  it('renders the active module popup view', async () => {
    const { container } = render(<PopupShell />);
    // Default module is clipboard; its popup renders a search input.
    // Lazy-loaded: wait for the chunk to resolve.
    await screen.findByRole('searchbox');
    expect(container.querySelector('[role="searchbox"]')).toBeInTheDocument();
  });

  it('wraps content in a pane container', () => {
    const { container } = render(<PopupShell />);
    expect(container.querySelector('.pane')).toBeInTheDocument();
  });

  it('does not mount views for tabs that were never opened', async () => {
    render(<PopupShell />);
    await screen.findByRole('searchbox');
    // Notes tab has not been clicked — its view must not be in the DOM.
    expect(screen.queryByPlaceholderText(/search notes/i)).toBeNull();
  });

  it('keeps previously opened tabs mounted (hidden) to preserve state', async () => {
    const user = userEvent.setup();
    render(<PopupShell />);
    await screen.findByRole('searchbox');
    await user.click(screen.getByRole('button', { name: /^Notes/ }));
    // Notes tab mounts.
    await screen.findByPlaceholderText(/search notes/i);
    // Back to clipboard — Notes view still in DOM but hidden.
    await user.click(screen.getByRole('button', { name: /^Clipboard/ }));
    await screen.findByRole('searchbox');
    const notesInput = document.querySelector(
      'input[placeholder*="Search notes" i]',
    );
    expect(notesInput).not.toBeNull();
    expect(notesInput?.closest('[hidden]')).not.toBeNull();
  });

  it('pin button toggles always-on-top and suppresses auto-hide', async () => {
    const user = userEvent.setup();
    render(<PopupShell />);
    const btn = screen.getByRole('button', { name: /pin window on top/i });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    await user.click(btn);
    const win = getCurrentWindow() as unknown as {
      setAlwaysOnTop: ReturnType<typeof vi.fn>;
    };
    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true);
    expect(invoke).toHaveBeenCalledWith('set_popup_auto_hide', {
      enabled: false,
    });
    const pinned = screen.getByRole('button', { name: /unpin window/i });
    expect(pinned).toHaveAttribute('aria-pressed', 'true');
    await user.click(pinned);
    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    expect(invoke).toHaveBeenLastCalledWith('set_popup_auto_hide', {
      enabled: true,
    });
  });

  it('auto-switches to Downloader when clipboard lands a supported URL', async () => {
    const handlers: Record<string, (e: { payload: unknown }) => void> = {};
    vi.mocked(listen).mockImplementation(
      // The real signature is generic over payload; the test only needs to
      // capture the callback per event name, so we cast at the boundary.
      ((event: string, cb: (e: { payload: unknown }) => void) => {
        handlers[event] = cb;
        return Promise.resolve(() => {});
      }) as unknown as typeof listen,
    );
    vi.mocked(readText).mockResolvedValue('https://youtu.be/abc123');
    const prefill = vi.fn();
    window.addEventListener('stash:downloader-prefill', prefill as EventListener);

    render(<PopupShell />);
    await screen.findByRole('searchbox');
    await waitFor(() => expect(handlers['clipboard:changed']).toBeDefined());
    handlers['clipboard:changed']!({ payload: 42 });

    await waitFor(() => expect(prefill).toHaveBeenCalled());
    const ev = prefill.mock.calls[0][0] as CustomEvent<string>;
    expect(ev.detail).toBe('https://youtu.be/abc123');
    window.removeEventListener('stash:downloader-prefill', prefill as EventListener);
  });

  it('ignores non-supported URLs from clipboard', async () => {
    const handlers: Record<string, (e: { payload: unknown }) => void> = {};
    vi.mocked(listen).mockImplementation(
      // The real signature is generic over payload; the test only needs to
      // capture the callback per event name, so we cast at the boundary.
      ((event: string, cb: (e: { payload: unknown }) => void) => {
        handlers[event] = cb;
        return Promise.resolve(() => {});
      }) as unknown as typeof listen,
    );
    vi.mocked(readText).mockResolvedValue('https://example.com/page');
    const prefill = vi.fn();
    window.addEventListener('stash:downloader-prefill', prefill as EventListener);

    render(<PopupShell />);
    await screen.findByRole('searchbox');
    await waitFor(() => expect(handlers['clipboard:changed']).toBeDefined());
    handlers['clipboard:changed']!({ payload: 1 });

    await new Promise((r) => setTimeout(r, 30));
    expect(prefill).not.toHaveBeenCalled();
    window.removeEventListener('stash:downloader-prefill', prefill as EventListener);
  });

  it('⌘⌥4 switches to the Notes module (bound to tabShortcutDigit, not index)', async () => {
    const user = userEvent.setup();
    render(<PopupShell />);
    await screen.findByRole('searchbox');
    await user.keyboard('{Meta>}{Alt>}4{/Alt}{/Meta}');
    await screen.findByPlaceholderText(/search notes/i);
    // Notes input must be visible (not inside a hidden container).
    const notesInput = document.querySelector(
      'input[placeholder*="Search notes" i]',
    );
    expect(notesInput?.closest('[hidden]')).toBeNull();
  });
});
