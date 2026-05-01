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

  it('shows the "не встановлено" copy with a primary Download button', async () => {
    mockBackend(notInstalled);
    render(<SeparatorTab />);
    expect(await screen.findByText(/не встановлено/i)).toBeInTheDocument();
    const buttons = await screen.findAllByRole('button', { name: /^Завантажити$/ });
    // Two buttons: the primary one for the base pack, the secondary for
    // the optional FT pack. Both labelled "Завантажити" — first is the
    // primary action and must be enabled.
    expect(buttons.length).toBe(2);
    expect(buttons[0]).toBeEnabled();
  });

  it('clicking the primary Download invokes separator_download with withFt=false', async () => {
    mockBackend(notInstalled);
    render(<SeparatorTab />);
    const buttons = await screen.findAllByRole('button', { name: /^Завантажити$/ });
    await userEvent.click(buttons[0]);
    expect(mockedInvoke).toHaveBeenCalledWith('separator_download', {
      withFt: false,
    });
  });

  it('disables the FT download button until the base pack is ready', async () => {
    mockBackend(notInstalled);
    render(<SeparatorTab />);
    const buttons = await screen.findAllByRole('button', { name: /^Завантажити$/ });
    expect(buttons[1]).toBeDisabled();
  });

  it('shows "Видалити все" + Прибрати and no Download when fully installed', async () => {
    mockBackend(fullyInstalled);
    render(<SeparatorTab />);
    expect(await screen.findByRole('button', { name: 'Видалити все' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Прибрати' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Завантажити$/ }),
    ).not.toBeInTheDocument();
  });

  it('exposes "Видалити все" alongside Download when something is partially staged', async () => {
    // Symptom seen in the field: install_flag was stamped against a
    // pre-fix venv, runtime_ready=true but the actual import probe
    // would fail. The user needs a way to wipe and start over without
    // having `status.ready` flip to true first.
    mockBackend({ ...notInstalled, runtime_ready: true });
    render(<SeparatorTab />);
    // There are two "Завантажити" buttons (core install + optional FT
    // pack); we just need to confirm both are present alongside the
    // wipe button.
    const downloads = await screen.findAllByRole('button', { name: /^Завантажити$/ });
    expect(downloads.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: 'Видалити все' })).toBeInTheDocument();
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
