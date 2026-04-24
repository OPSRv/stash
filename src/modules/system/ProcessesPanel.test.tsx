import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { ToastProvider } from '../../shared/ui/Toast';
import { ProcessesPanel } from './ProcessesPanel';
import type { ProcessInfo } from './api';

const mkProc = (over: Partial<ProcessInfo>): ProcessInfo => ({
  pid: 100,
  rss_bytes: 100 * 1024 * 1024,
  cpu_percent: 1,
  user: 'alice',
  name: 'node',
  command: 'node',
  ...over,
});

const renderPanel = () =>
  render(
    <ToastProvider>
      <ProcessesPanel />
    </ToastProvider>,
  );

describe('ProcessesPanel', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('filters to ≥500 MB by default', async () => {
    vi.mocked(invoke).mockResolvedValue([
      mkProc({ pid: 1, name: 'chrome', rss_bytes: 900 * 1024 * 1024 }),
      mkProc({ pid: 2, name: 'tiny', rss_bytes: 10 * 1024 * 1024 }),
    ]);
    renderPanel();
    await waitFor(() => expect(screen.getByText('chrome')).toBeInTheDocument());
    expect(screen.queryByText('tiny')).not.toBeInTheDocument();
    expect(screen.getByText(/1 heavy \/ 2 total/)).toBeInTheDocument();
  });

  it('disables the heavy filter via the toggle to show all processes', async () => {
    vi.mocked(invoke).mockResolvedValue([
      mkProc({ pid: 1, name: 'chrome', rss_bytes: 900 * 1024 * 1024 }),
      mkProc({ pid: 2, name: 'tiny', rss_bytes: 10 * 1024 * 1024 }),
    ]);
    renderPanel();
    await waitFor(() => expect(screen.getByText('chrome')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(screen.getByText('tiny')).toBeInTheDocument());
  });

  it('filters by free-text query across name, command, pid', async () => {
    vi.mocked(invoke).mockResolvedValue([
      mkProc({ pid: 1, name: 'chrome', rss_bytes: 900 * 1024 * 1024 }),
      mkProc({ pid: 2, name: 'firefox', rss_bytes: 700 * 1024 * 1024 }),
    ]);
    renderPanel();
    await waitFor(() => expect(screen.getByText('chrome')).toBeInTheDocument());
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'fire' } });
    await waitFor(() => expect(screen.queryByText('chrome')).not.toBeInTheDocument());
    expect(screen.getByText('firefox')).toBeInTheDocument();
  });

  it('confirms before killing and sends SIGKILL when Force is used', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'system_list_processes') {
        return [mkProc({ pid: 777, name: 'eater', rss_bytes: 800 * 1024 * 1024 })];
      }
      return undefined;
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText('eater')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Force' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Force quit' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('system_kill_process', {
        pid: 777,
        force: true,
      }),
    );
  });

  it('sorts heaviest process first by default (RAM desc)', async () => {
    vi.mocked(invoke).mockResolvedValue([
      mkProc({ pid: 1, name: 'mid', rss_bytes: 700 * 1024 * 1024 }),
      mkProc({ pid: 2, name: 'giant', rss_bytes: 2000 * 1024 * 1024 }),
      mkProc({ pid: 3, name: 'small-heavy', rss_bytes: 520 * 1024 * 1024 }),
    ]);
    renderPanel();
    await waitFor(() => expect(screen.getByText('giant')).toBeInTheDocument());
    const names = screen
      .getAllByRole('row')
      .slice(1) // first row is the pinned header
      .map((r) => r.querySelector('.font-medium')?.textContent?.trim());
    expect(names).toEqual(['giant', 'mid', 'small-heavy']);
    expect(screen.getByRole('radio', { name: /RAM/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('shows an empty state when no heavy processes exist', async () => {
    vi.mocked(invoke).mockResolvedValue([
      mkProc({ pid: 2, name: 'tiny', rss_bytes: 10 * 1024 * 1024 }),
    ]);
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText(/No heavy processes found/)).toBeInTheDocument(),
    );
  });
});
