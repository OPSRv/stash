import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
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
