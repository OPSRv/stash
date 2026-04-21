import { describe, it, expect, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { cancelScan } from './api';

describe('cancelScan', () => {
  it('maps each kind to the system_cancel_scan command', async () => {
    vi.mocked(invoke).mockResolvedValue(true);
    await cancelScan('large_files');
    expect(invoke).toHaveBeenCalledWith('system_cancel_scan', {
      kind: 'large_files',
    });
    await cancelScan('node_modules');
    expect(invoke).toHaveBeenCalledWith('system_cancel_scan', {
      kind: 'node_modules',
    });
    await cancelScan('duplicates');
    expect(invoke).toHaveBeenCalledWith('system_cancel_scan', {
      kind: 'duplicates',
    });
  });
});
