import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  musicStatus,
  musicEmbed,
  musicShow,
  musicHide,
  musicClose,
  musicReload,
  musicPlayPause,
  musicNext,
  musicPrev,
} from './api';

describe('music api', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  it('musicStatus returns payload from music_status', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ attached: true, visible: false });
    await expect(musicStatus()).resolves.toEqual({ attached: true, visible: false });
    expect(invoke).toHaveBeenCalledWith('music_status');
  });

  it('musicEmbed forwards rect args', async () => {
    await musicEmbed({ x: 1, y: 2, width: 300, height: 80, userAgent: 'UA/1.0' });
    expect(invoke).toHaveBeenCalledWith('music_embed', {
      x: 1,
      y: 2,
      width: 300,
      height: 80,
      userAgent: 'UA/1.0',
    });
  });

  it.each([
    ['musicShow', musicShow, 'music_show'],
    ['musicHide', musicHide, 'music_hide'],
    ['musicClose', musicClose, 'music_close'],
    ['musicReload', musicReload, 'music_reload'],
    ['musicPlayPause', musicPlayPause, 'music_play_pause'],
    ['musicNext', musicNext, 'music_next'],
    ['musicPrev', musicPrev, 'music_prev'],
  ])('%s → %s', async (_name, fn, cmd) => {
    await fn();
    expect(invoke).toHaveBeenCalledWith(cmd);
  });

  it('propagates invoke rejections', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('no webview'));
    await expect(musicShow()).rejects.toThrow('no webview');
  });
});
