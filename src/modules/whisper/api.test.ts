import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  whisperListModels,
  whisperDownloadModel,
  whisperDeleteModel,
  whisperSetActive,
  whisperGetActive,
  whisperTranscribePath,
  type ModelRow,
} from './api';

const model = (over: Partial<ModelRow> = {}): ModelRow => ({
  id: 'tiny',
  label: 'tiny',
  size_bytes: 75 * 1024 * 1024,
  ram_mb: 400,
  language: 'multi',
  quantized: false,
  accuracy: 0.6,
  realtime_intel_2018: 10,
  recommended_intel: true,
  url: 'https://example.com/tiny.bin',
  downloaded: false,
  active: false,
  ...over,
});

describe('whisper api', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  it('whisperListModels returns rows', async () => {
    const rows = [model(), model({ id: 'small', active: true })];
    vi.mocked(invoke).mockResolvedValueOnce(rows);
    await expect(whisperListModels()).resolves.toEqual(rows);
    expect(invoke).toHaveBeenCalledWith('whisper_list_models');
  });

  it('whisperDownloadModel forwards id', async () => {
    await whisperDownloadModel('medium');
    expect(invoke).toHaveBeenCalledWith('whisper_download_model', { id: 'medium' });
  });

  it('whisperDeleteModel forwards id', async () => {
    await whisperDeleteModel('tiny');
    expect(invoke).toHaveBeenCalledWith('whisper_delete_model', { id: 'tiny' });
  });

  it('whisperSetActive with id and with null', async () => {
    await whisperSetActive('small');
    expect(invoke).toHaveBeenCalledWith('whisper_set_active', { id: 'small' });
    await whisperSetActive(null);
    expect(invoke).toHaveBeenCalledWith('whisper_set_active', { id: null });
  });

  it('whisperGetActive returns id or null', async () => {
    vi.mocked(invoke).mockResolvedValueOnce('small');
    await expect(whisperGetActive()).resolves.toBe('small');
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await expect(whisperGetActive()).resolves.toBeNull();
  });

  it('whisperTranscribePath defaults language to uk and forwards path', async () => {
    vi.mocked(invoke).mockResolvedValueOnce('hello world');
    await expect(whisperTranscribePath('/tmp/a.mp3')).resolves.toBe('hello world');
    expect(invoke).toHaveBeenCalledWith('whisper_transcribe_path', {
      path: '/tmp/a.mp3',
      language: 'uk',
    });
  });

  it('whisperTranscribePath respects explicit language', async () => {
    vi.mocked(invoke).mockResolvedValueOnce('ok');
    await whisperTranscribePath('/tmp/a.mp3', 'en');
    expect(invoke).toHaveBeenCalledWith('whisper_transcribe_path', {
      path: '/tmp/a.mp3',
      language: 'en',
    });
  });

  it('propagates invoke rejections', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('no model active'));
    await expect(whisperTranscribePath('/tmp/a.mp3')).rejects.toThrow('no model active');
  });
});
