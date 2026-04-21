import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StashCliRow } from './StashCliRow';

const invokeMock = vi.mocked(invoke);

describe('StashCliRow', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('renders Install action when CLI is not installed', async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === 'stash_cli_status') {
        return {
          binary_available: true,
          binary_path: '/Applications/Stash.app/Contents/Resources/bin/stash',
          installed_at: null,
        };
      }
      return null;
    });

    render(<StashCliRow />);

    const btn = await screen.findByRole('button', { name: /install/i });
    expect(btn).toBeEnabled();
    expect(screen.getByText(/from any Terminal window/i)).toBeInTheDocument();
  });

  it('shows installed path and Uninstall when status reports a symlink', async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === 'stash_cli_status') {
        return {
          binary_available: true,
          binary_path: '/Applications/Stash.app/Contents/Resources/bin/stash',
          installed_at: '/usr/local/bin/stash',
        };
      }
      return null;
    });

    render(<StashCliRow />);

    await screen.findByRole('button', { name: /uninstall/i });
    expect(screen.getByText(/Installed at \/usr\/local\/bin\/stash/)).toBeInTheDocument();
  });

  it('disables Install and explains when binary is unavailable', async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === 'stash_cli_status') {
        return {
          binary_available: false,
          binary_path: null,
          installed_at: null,
        };
      }
      return null;
    });

    render(<StashCliRow />);

    const btn = await screen.findByRole('button', { name: /install/i });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/CLI binary is missing/i)).toBeInTheDocument();
  });

  it('re-queries status after a successful install', async () => {
    let installedAt: string | null = null;
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === 'stash_cli_status') {
        return {
          binary_available: true,
          binary_path: '/Applications/Stash.app/Contents/Resources/bin/stash',
          installed_at: installedAt,
        };
      }
      if (cmd === 'stash_cli_install') {
        installedAt = '/usr/local/bin/stash';
        return installedAt;
      }
      return null;
    });

    render(<StashCliRow />);
    const installBtn = await screen.findByRole('button', { name: /install/i });
    await userEvent.click(installBtn);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /uninstall/i }),
      ).toBeInTheDocument();
    });
    expect(invokeMock).toHaveBeenCalledWith('stash_cli_install');
  });

  it('surfaces an install error without crashing', async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === 'stash_cli_status') {
        return {
          binary_available: true,
          binary_path: '/x/stash',
          installed_at: null,
        };
      }
      if (cmd === 'stash_cli_install') {
        throw 'admin prompt cancelled';
      }
      return null;
    });

    render(<StashCliRow />);
    const btn = await screen.findByRole('button', { name: /install/i });
    await userEvent.click(btn);

    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('admin prompt cancelled');
  });
});
