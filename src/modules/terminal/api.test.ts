import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ptyOpen, ptyWrite, ptyResize, ptyClose } from './api';

describe('terminal api', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(null);
  });

  it('ptyOpen invokes pty_open with cols/rows', async () => {
    await ptyOpen(120, 40);
    expect(invoke).toHaveBeenCalledWith('pty_open', { cols: 120, rows: 40 });
  });

  it('ptyWrite invokes pty_write with the data string', async () => {
    await ptyWrite('ls\n');
    expect(invoke).toHaveBeenCalledWith('pty_write', { data: 'ls\n' });
  });

  it('ptyResize invokes pty_resize with cols/rows', async () => {
    await ptyResize(80, 24);
    expect(invoke).toHaveBeenCalledWith('pty_resize', { cols: 80, rows: 24 });
  });

  it('ptyClose invokes pty_close with no args', async () => {
    await ptyClose();
    expect(invoke).toHaveBeenCalledWith('pty_close');
  });

  it('propagates invoke rejections', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('pty busy'));
    await expect(ptyOpen(80, 24)).rejects.toThrow('pty busy');
  });
});
