import { describe, expect, it, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import * as api from './api';

const mockedInvoke = vi.mocked(invoke);

describe('separator/api', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedInvoke.mockResolvedValue(undefined);
  });

  it('isSupportedAudio recognises common audio extensions', () => {
    expect(api.isSupportedAudio('/x/song.mp3')).toBe(true);
    expect(api.isSupportedAudio('/x/song.M4A')).toBe(true);
    expect(api.isSupportedAudio('/x/song.flac')).toBe(true);
    expect(api.isSupportedAudio('/x/song.WAV')).toBe(true);
    expect(api.isSupportedAudio('/x/song.opus')).toBe(true);
    expect(api.isSupportedAudio('/x/clip.mp4')).toBe(false);
    expect(api.isSupportedAudio('/x/cover.jpg')).toBe(false);
    expect(api.isSupportedAudio('/x/no-extension')).toBe(false);
  });

  it('STEM_LABELS covers the 6-stem set', () => {
    for (const stem of ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']) {
      expect(api.STEM_LABELS[stem]).toBeTruthy();
    }
  });

  it('run() forwards args under the expected camelCase shape', async () => {
    mockedInvoke.mockResolvedValue('sep-1');
    const id = await api.run({
      inputPath: '/x/song.mp3',
      model: 'htdemucs_6s',
      mode: 'analyze',
      stems: ['vocals', 'drums'],
      outputDir: '/Music/Stash Stems',
    });
    expect(id).toBe('sep-1');
    expect(mockedInvoke).toHaveBeenCalledWith('separator_run', {
      args: {
        inputPath: '/x/song.mp3',
        model: 'htdemucs_6s',
        mode: 'analyze',
        stems: ['vocals', 'drums'],
        outputDir: '/Music/Stash Stems',
      },
    });
  });

  it('run() defaults missing optionals to null so Tauri serialises Option::None', async () => {
    mockedInvoke.mockResolvedValue('sep-2');
    await api.run({ inputPath: '/x/song.flac' });
    expect(mockedInvoke).toHaveBeenCalledWith('separator_run', {
      args: {
        inputPath: '/x/song.flac',
        model: null,
        mode: null,
        stems: null,
        outputDir: null,
      },
    });
  });

  it('download(withFt) maps to camelCase argument', async () => {
    await api.download(true);
    expect(mockedInvoke).toHaveBeenCalledWith('separator_download', { withFt: true });
    await api.download(false);
    expect(mockedInvoke).toHaveBeenCalledWith('separator_download', { withFt: false });
  });

  it('remove(ftOnly) maps to camelCase argument', async () => {
    await api.remove(true);
    expect(mockedInvoke).toHaveBeenCalledWith('separator_delete', { ftOnly: true });
  });

  it('cancel/listJobs/clearCompleted hit the right command names', async () => {
    await api.cancel('sep-1');
    expect(mockedInvoke).toHaveBeenCalledWith('separator_cancel', { jobId: 'sep-1' });
    mockedInvoke.mockResolvedValueOnce([]);
    await api.listJobs();
    expect(mockedInvoke).toHaveBeenCalledWith('separator_list_jobs');
    await api.clearCompleted();
    expect(mockedInvoke).toHaveBeenCalledWith('separator_clear_completed');
  });
});
