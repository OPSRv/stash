import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';
import { SeparatorTab } from './SeparatorTab';
import type { SeparatorStatus } from '../modules/separator/api';

const mockedInvoke = vi.mocked(invoke);

const notInstalled: SeparatorStatus = {
  ready: false,
  runtime_ready: false,
  ft_ready: false,
  default_output_dir: '/Music/Stash Stems',
  assets: [
    {
      kind: 'htdemucs_6s',
      label: 'htdemucs_6s',
      size_bytes: 81_000_000,
      optional: false,
      downloaded: false,
      local_path: null,
    },
    {
      kind: 'htdemucs_ft_vocals',
      label: 'htdemucs_ft · vocals',
      size_bytes: 81_000_000,
      optional: true,
      downloaded: false,
      local_path: null,
    },
  ],
};

const fullyInstalled: SeparatorStatus = {
  ready: true,
  runtime_ready: true,
  ft_ready: true,
  default_output_dir: '/Music/Stash Stems',
  assets: notInstalled.assets.map((a) => ({
    ...a,
    downloaded: true,
    local_path: `/x/${a.kind}`,
  })),
};

function mockBackend(s: SeparatorStatus) {
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'separator_status') return s;
    return undefined;
  });
}

describe('SeparatorTab', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it('shows the "not installed" copy with a primary Install button', async () => {
    mockBackend(notInstalled);
    render(<SeparatorTab />);
    expect(await screen.findByText(/not installed/i)).toBeInTheDocument();
    const buttons = await screen.findAllByRole('button', { name: /^Install$/ });
    // Two buttons: the primary one for the base pack, the secondary
    // for the optional FT pack. Both labelled "Install" — the first
    // is the primary action and must be enabled.
    expect(buttons.length).toBe(2);
    expect(buttons[0]).toBeEnabled();
  });

  it('clicking the primary Install invokes separator_download with withFt=false', async () => {
    mockBackend(notInstalled);
    render(<SeparatorTab />);
    const buttons = await screen.findAllByRole('button', { name: /^Install$/ });
    await userEvent.click(buttons[0]);
    expect(mockedInvoke).toHaveBeenCalledWith('separator_download', {
      withFt: false,
    });
  });

  it('disables the FT install button until the base pack is ready', async () => {
    mockBackend(notInstalled);
    render(<SeparatorTab />);
    const buttons = await screen.findAllByRole('button', { name: /^Install$/ });
    expect(buttons[1]).toBeDisabled();
  });

  it('shows Wipe + Remove and no Install when fully installed', async () => {
    mockBackend(fullyInstalled);
    render(<SeparatorTab />);
    expect(await screen.findByRole('button', { name: 'Wipe' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Install$/ }),
    ).not.toBeInTheDocument();
  });

  it('exposes Wipe alongside Install when something is partially staged', async () => {
    // Field symptom: install_flag was stamped against a pre-fix venv,
    // runtime_ready=true but the actual import probe would fail. The
    // user needs a way to wipe and start over without having
    // `status.ready` flip to true first.
    mockBackend({ ...notInstalled, runtime_ready: true });
    render(<SeparatorTab />);
    const installs = await screen.findAllByRole('button', { name: /^Install$/ });
    expect(installs.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: 'Wipe' })).toBeEnabled();
  });

  it('renders one row per catalog asset', async () => {
    mockBackend(notInstalled);
    render(<SeparatorTab />);
    await waitFor(() =>
      expect(screen.getByTestId('separator-asset-list')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('asset-htdemucs_6s')).toBeInTheDocument();
    expect(screen.getByTestId('asset-htdemucs_ft_vocals')).toBeInTheDocument();
  });
});
