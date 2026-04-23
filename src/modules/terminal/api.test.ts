import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ptyOpen, ptyWrite, ptyResize, ptyClose } from './api';

describe('terminal api', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(null);
  });

  it('ptyOpen invokes pty_open with id + cols/rows', async () => {
    await ptyOpen('pane-1', 120, 40);
    expect(invoke).toHaveBeenCalledWith('pty_open', {
      id: 'pane-1',
      cols: 120,
      rows: 40,
    });
  });

  it('ptyWrite forwards id + data', async () => {
    await ptyWrite('pane-2', 'ls\n');
    expect(invoke).toHaveBeenCalledWith('pty_write', {
      id: 'pane-2',
      data: 'ls\n',
    });
  });

  it('ptyResize forwards id + cols/rows', async () => {
    await ptyResize('pane-1', 80, 24);
    expect(invoke).toHaveBeenCalledWith('pty_resize', {
      id: 'pane-1',
      cols: 80,
      rows: 24,
    });
  });

  it('ptyClose forwards the id', async () => {
    await ptyClose('pane-3');
    expect(invoke).toHaveBeenCalledWith('pty_close', { id: 'pane-3' });
  });

  it('propagates invoke rejections', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('pty busy'));
    await expect(ptyOpen('pane-1', 80, 24)).rejects.toThrow('pty busy');
  });
});
