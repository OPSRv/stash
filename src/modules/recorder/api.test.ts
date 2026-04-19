import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  recDelete,
  recList,
  recProbePermissions,
  recSetOutputDir,
  recStart,
  recStatus,
  recStop,
  recTrim,
} from './api';

describe('recorder/api', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined as never);
  });

  it('recStart passes through mode/mic/fps/filename', async () => {
    vi.mocked(invoke).mockResolvedValue('/tmp/out.mov' as never);
    const p = await recStart({ mode: 'screen', mic: true, fps: 30, filename: 'x.mov' });
    expect(p).toBe('/tmp/out.mov');
    expect(invoke).toHaveBeenCalledWith('rec_start', {
      mode: 'screen',
      mic: true,
      fps: 30,
      filename: 'x.mov',
    });
  });

  it('recStop / recStatus / recProbePermissions are argument-less', async () => {
    await recStop();
    await recStatus();
    await recProbePermissions();
    expect(invoke).toHaveBeenCalledWith('rec_stop');
    expect(invoke).toHaveBeenCalledWith('rec_status');
    expect(invoke).toHaveBeenCalledWith('rec_probe_permissions');
  });

  it('recSetOutputDir forwards { path }', async () => {
    await recSetOutputDir('/tmp/recs');
    await recSetOutputDir(null);
    expect(invoke).toHaveBeenCalledWith('rec_set_output_dir', { path: '/tmp/recs' });
    expect(invoke).toHaveBeenCalledWith('rec_set_output_dir', { path: null });
  });

  it('recList is argument-less', async () => {
    await recList();
    expect(invoke).toHaveBeenCalledWith('rec_list');
  });

  it('recDelete forwards path', async () => {
    await recDelete('/tmp/x.mov');
    expect(invoke).toHaveBeenCalledWith('rec_delete', { path: '/tmp/x.mov' });
  });

  it('recTrim forwards source/start/end', async () => {
    vi.mocked(invoke).mockResolvedValue('/tmp/out.mov' as never);
    const p = await recTrim('/tmp/src.mov', 1.5, 4.2);
    expect(p).toBe('/tmp/out.mov');
    expect(invoke).toHaveBeenCalledWith('rec_trim', {
      source: '/tmp/src.mov',
      start: 1.5,
      end: 4.2,
    });
  });
});
