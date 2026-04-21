import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { killProcess, listProcesses } from './api';

describe('system api', () => {
  it('lists processes via the matching invoke command', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      {
        pid: 42,
        rss_bytes: 600_000_000,
        cpu_percent: 1.2,
        user: 'alice',
        name: 'node',
        command: 'node server.js',
      },
    ]);
    const rows = await listProcesses();
    expect(invoke).toHaveBeenCalledWith('system_list_processes');
    expect(rows[0].pid).toBe(42);
  });

  it('forwards pid and force to system_kill_process', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await killProcess(123, true);
    expect(invoke).toHaveBeenCalledWith('system_kill_process', { pid: 123, force: true });
  });
});
