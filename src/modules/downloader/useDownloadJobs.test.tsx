import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listen, type EventCallback, type EventName } from '@tauri-apps/api/event';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, list: vi.fn() };
});

vi.mock('../../settings/store', () => ({
  loadSettings: vi.fn(),
}));

import { loadSettings } from '../../settings/store';
import { list, type DownloadJob } from './api';
import { useDownloadJobs } from './useDownloadJobs';

type CompletedPayload = { id: number; path: string };
type CompletedHandler = EventCallback<CompletedPayload>;

/// Minimal `Event<T>` shape Tauri's `EventCallback` expects. The hook only
/// reads `payload` — the other fields are placeholders so the type lines up.
const fireCompleted = (handler: CompletedHandler, payload: CompletedPayload) =>
  handler({ event: 'downloader:completed', id: 0, payload });

/// Capture the handler registered for a specific channel, returning the
/// `listen` mock implementation paired with a getter for the captured fn.
const captureCompletedHandler = () => {
  let captured: CompletedHandler | null = null;
  vi.mocked(listen).mockImplementation(
    (async (channel: EventName, handler: EventCallback<unknown>) => {
      if (channel === 'downloader:completed') {
        captured = handler as CompletedHandler;
      }
      return () => {};
    }) as typeof listen,
  );
  return () => captured;
};

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

/// Resolve the `loadSettings` mock with the supplied overrides on top of a
/// minimal payload. We only need the two flags `useDownloadJobs` actually
/// reads — keeping the rest as `unknown` instead of dragging the full
/// `Settings` shape into the test setup.
const mockSettings = (overrides: Record<string, unknown>) => {
  vi.mocked(loadSettings).mockResolvedValue({
    notifyOnDownloadComplete: false,
    downloaderAutoStems: false,
    ...overrides,
  } as never);
};

describe('useDownloadJobs', () => {
  beforeEach(() => {
    vi.mocked(list).mockReset();
    vi.mocked(listen).mockReset();
    vi.mocked(listen).mockResolvedValue(() => {});
    vi.mocked(loadSettings).mockReset();
    mockSettings({});
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

  it('auto-routes a completed audio download to the Stems tab when enabled', async () => {
    mockSettings({ downloaderAutoStems: true });
    vi.mocked(list).mockResolvedValue([]);
    const getHandler = captureCompletedHandler();
    const events: CustomEvent<unknown>[] = [];
    const trap = (e: Event) => events.push(e as CustomEvent<unknown>);
    window.addEventListener('stash:navigate', trap as EventListener);
    try {
      renderHook(() => useDownloadJobs());
      // Wait for `loadSettings` to land in the ref and `listen` to wire up
      // the completed channel before firing the synthetic event.
      await waitFor(() => expect(getHandler()).not.toBeNull());

      act(() => fireCompleted(getHandler()!, { id: 9, path: '/Movies/Stash/song.m4a' }));

      expect(events).toHaveLength(1);
      expect(events[0].detail).toEqual({
        tabId: 'separator',
        file: '/Movies/Stash/song.m4a',
      });
    } finally {
      window.removeEventListener('stash:navigate', trap as EventListener);
    }
  });

  it('does not auto-route video downloads even when auto-stems is enabled', async () => {
    mockSettings({ downloaderAutoStems: true });
    vi.mocked(list).mockResolvedValue([]);
    const getHandler = captureCompletedHandler();
    const events: Event[] = [];
    const trap = (e: Event) => events.push(e);
    window.addEventListener('stash:navigate', trap as EventListener);
    try {
      renderHook(() => useDownloadJobs());
      await waitFor(() => expect(getHandler()).not.toBeNull());

      act(() => fireCompleted(getHandler()!, { id: 9, path: '/Movies/Stash/clip.mp4' }));

      // Demucs can't read mp4 — silent skip is the correct behaviour.
      expect(events).toHaveLength(0);
    } finally {
      window.removeEventListener('stash:navigate', trap as EventListener);
    }
  });

  it('does not auto-route when auto-stems is disabled', async () => {
    mockSettings({ downloaderAutoStems: false });
    vi.mocked(list).mockResolvedValue([]);
    const getHandler = captureCompletedHandler();
    const events: Event[] = [];
    const trap = (e: Event) => events.push(e);
    window.addEventListener('stash:navigate', trap as EventListener);
    try {
      renderHook(() => useDownloadJobs());
      await waitFor(() => expect(getHandler()).not.toBeNull());

      act(() => fireCompleted(getHandler()!, { id: 9, path: '/Movies/Stash/song.m4a' }));

      expect(events).toHaveLength(0);
    } finally {
      window.removeEventListener('stash:navigate', trap as EventListener);
    }
  });
});
