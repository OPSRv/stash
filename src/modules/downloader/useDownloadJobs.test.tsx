import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, list: vi.fn() };
});

import { list, type DownloadJob } from './api';
import { useDownloadJobs } from './useDownloadJobs';

const job = (overrides: Partial<DownloadJob>): DownloadJob => ({
  id: 1,
  url: 'u',
  platform: 'youtube',
  title: null,
  thumbnail_url: null,
  format_id: null,
  target_path: null,
  status: 'pending',
  progress: 0,
  bytes_total: null,
  bytes_done: null,
  error: null,
  created_at: 0,
  completed_at: null,
  transcription: null,
  ...overrides,
});

describe('useDownloadJobs', () => {
  beforeEach(() => {
    vi.mocked(list).mockReset();
    vi.mocked(listen).mockReset();
    vi.mocked(listen).mockResolvedValue(() => {});
  });

  it('partitions jobs into active and completed buckets', async () => {
    vi.mocked(list).mockResolvedValue([
      job({ id: 1, status: 'active' }),
      job({ id: 2, status: 'pending' }),
      job({ id: 3, status: 'paused' }),
      job({ id: 4, status: 'completed' }),
      job({ id: 5, status: 'failed' }),
      job({ id: 6, status: 'cancelled' }),
    ]);
    const { result } = renderHook(() => useDownloadJobs());
    await waitFor(() => expect(result.current.jobs).toHaveLength(6));
    expect(result.current.active.map((j) => j.id)).toEqual([1, 2, 3]);
    expect(result.current.completed.map((j) => j.id)).toEqual([4, 5, 6]);
  });

  it('subscribes to progress / completed / failed event channels', async () => {
    vi.mocked(list).mockResolvedValue([]);
    renderHook(() => useDownloadJobs());
    await waitFor(() => {
      expect(listen).toHaveBeenCalledWith('downloader:progress', expect.any(Function));
      expect(listen).toHaveBeenCalledWith('downloader:completed', expect.any(Function));
      expect(listen).toHaveBeenCalledWith('downloader:failed', expect.any(Function));
    });
  });

  it('reload() re-fetches the job list', async () => {
    vi.mocked(list).mockResolvedValue([]);
    const { result } = renderHook(() => useDownloadJobs());
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    act(() => result.current.reload());
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });
});
