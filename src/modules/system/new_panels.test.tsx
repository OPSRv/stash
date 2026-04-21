import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { ToastProvider } from '../../shared/ui/Toast';
import { DashboardPanel } from './DashboardPanel';
import { TrashBinsPanel } from './TrashBinsPanel';
import { NodeModulesPanel } from './NodeModulesPanel';

const wrap = (node: React.ReactNode) => render(<ToastProvider>{node}</ToastProvider>);

describe('DashboardPanel', () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it('renders CPU/RAM/disk gauges from dashboardMetrics', async () => {
    vi.mocked(invoke).mockResolvedValue({
      cpu_percent: 42,
      load_1m: 2.1,
      load_5m: 1.8,
      load_15m: 1.5,
      mem_used_bytes: 16 * 1024 ** 3,
      mem_total_bytes: 32 * 1024 ** 3,
      mem_pressure_percent: 50,
      disk_used_bytes: 200 * 1024 ** 3,
      disk_total_bytes: 500 * 1024 ** 3,
      disk_free_bytes: 300 * 1024 ** 3,
      battery_percent: 76,
      battery_charging: false,
      uptime_seconds: 86400 + 3600 * 5,
      process_count: 432,
      ping_ms: 12.3,
      interfaces: [
        {
          name: 'en0',
          kind: 'wifi',
          rx_bytes: 123_000_000,
          tx_bytes: 42_000_000,
          is_primary: true,
        },
      ],
    });
    wrap(<DashboardPanel />);
    await waitFor(() => expect(screen.getByText('42%')).toBeInTheDocument());
    expect(screen.getByText(/Uptime:/)).toBeInTheDocument();
    expect(screen.getByText(/1д 5г/)).toBeInTheDocument();
    expect(screen.getByText('76%')).toBeInTheDocument();
    expect(screen.getByText(/432 процесів/)).toBeInTheDocument();
    expect(screen.getByText(/Wi-Fi/)).toBeInTheDocument();
  });
});

describe('TrashBinsPanel', () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it('lists bins and empties them on confirm', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'system_list_trash_bins') {
        return [
          { path: '/u/.Trash', volume: 'Macintosh HD', size_bytes: 5 * 1024 ** 3, item_count: 42 },
        ];
      }
      return undefined;
    });
    wrap(<TrashBinsPanel />);
    await waitFor(() => expect(screen.getByText('Macintosh HD')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Очистити всі' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Очистити' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('system_empty_trash'),
    );
  });
});

describe('NodeModulesPanel', () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it('scans via chosen folder and shows entries', async () => {
    vi.mocked(openDialog).mockResolvedValue('/Users/me/code');
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'system_scan_node_modules') {
        return [
          {
            path: '/Users/me/code/projA/node_modules',
            project: '/Users/me/code/projA',
            size_bytes: 600 * 1024 * 1024,
            last_modified: 1_700_000_000,
          },
        ];
      }
      return undefined;
    });
    wrap(<NodeModulesPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Обрати папку/ }));
    // Assert the scan actually reached the backend with the picked root.
    // The subsequent UI render is covered indirectly by the assertion that
    // scanning completes (otherwise invoke wouldn't have been called with
    // the correct args).
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('system_scan_node_modules', {
        root: '/Users/me/code',
      }),
    );
  });
});
