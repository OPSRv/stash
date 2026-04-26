import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { SettingsShell } from './SettingsShell';

describe('SettingsShell', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined as unknown as never);
    vi.mocked(openDialog).mockReset();
  });

  it('renders tabs and defaults to General', () => {
    render(<SettingsShell />);
    expect(screen.getByRole('tab', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByText(/Launch at login/)).toBeInTheDocument();
  });

  it('switches to Clipboard tab and shows history cap input', async () => {
    const user = userEvent.setup();
    render(<SettingsShell />);
    await user.click(screen.getByRole('tab', { name: 'Clipboard' }));
    await waitFor(() => {
      expect(screen.getByText(/Max history items/)).toBeInTheDocument();
    });
  });

  it('switches to About tab', async () => {
    const user = userEvent.setup();
    render(<SettingsShell />);
    await user.click(screen.getByRole('tab', { name: 'About' }));
    expect(screen.getByText('Stash')).toBeInTheDocument();
  });

  it('exposes Browser (cookies) under General, not Downloads', async () => {
    const user = userEvent.setup();
    render(<SettingsShell />);
    // General is the default tab; the BROWSER section ships there now.
    expect(screen.getByText(/Default browser/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Forget$/ })).toBeInTheDocument();

    // Downloads no longer hosts cookies.
    await user.click(screen.getByRole('tab', { name: 'Downloads' }));
    await waitFor(() => {
      expect(screen.getByText(/Bandwidth limit/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Default browser/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Forget$/ })).not.toBeInTheDocument();
  });

  it('shows window position controls under General, not Appearance', async () => {
    const user = userEvent.setup();
    render(<SettingsShell />);
    expect(
      screen.getByRole('button', { name: /Reset position/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Appearance' }));
    await waitFor(() => {
      expect(screen.getByText(/Translucency/)).toBeInTheDocument();
    });
    expect(
      screen.queryByRole('button', { name: /Reset position/i }),
    ).not.toBeInTheDocument();
  });

  it('exposes the Data tab with backup + diagnostics actions', async () => {
    const user = userEvent.setup();
    render(<SettingsShell />);
    await user.click(screen.getByRole('tab', { name: 'Data' }));
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Export backup/i }),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /^Open…$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Collect$/ })).toBeInTheDocument();
  });

  it('wraps the folder picker with set_popup_auto_hide to keep the dialog open', async () => {
    const user = userEvent.setup();
    // Record the order of IPC calls relative to the native dialog.
    const calls: string[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'set_popup_auto_hide') {
        const enabled = (args as { enabled: boolean }).enabled;
        calls.push(`hide:${enabled}`);
      }
      return undefined as never;
    });
    vi.mocked(openDialog).mockImplementation(async () => {
      calls.push('dialog');
      return '/Users/test/Movies/Custom' as never;
    });

    render(<SettingsShell />);
    await user.click(screen.getByRole('tab', { name: 'Downloads' }));
    await user.click(await screen.findByRole('button', { name: /Choose/ }));

    await waitFor(() => {
      expect(calls).toEqual(['hide:false', 'dialog', 'hide:true']);
    });
    // Selected path propagates through saveSetting → setDownloadsDir.
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('dl_set_downloads_dir', {
      path: '/Users/test/Movies/Custom',
    });
  });

  it('re-enables auto-hide even if the user cancels the dialog', async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'set_popup_auto_hide') {
        seen.push(`hide:${(args as { enabled: boolean }).enabled}`);
      }
      return undefined as never;
    });
    vi.mocked(openDialog).mockResolvedValue(null as never);

    render(<SettingsShell />);
    await user.click(screen.getByRole('tab', { name: 'Downloads' }));
    await user.click(await screen.findByRole('button', { name: /Choose/ }));

    await waitFor(() => {
      expect(seen).toContain('hide:false');
      expect(seen).toContain('hide:true');
    });
  });
});
