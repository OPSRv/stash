import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { loadSettings } from '../../settings/store';
import { list, type DownloadJob } from './api';

interface UseDownloadJobsResult {
  jobs: DownloadJob[];
  active: DownloadJob[];
  completed: DownloadJob[];
  reload: () => void;
}

const ACTIVE_STATUSES = new Set<DownloadJob['status']>(['active', 'pending', 'paused']);
const COMPLETED_STATUSES = new Set<DownloadJob['status']>([
  'completed',
  'failed',
  'cancelled',
]);

type ProgressPayload = {
  id: number;
  update: {
    percent: number;
    bytes_done: number | null;
    bytes_total: number | null;
  };
};

/// Subscribes to downloader events and keeps a derived {active, completed}
/// partition in sync. Also handles native notifications so the view layer
/// stays declarative.
export const useDownloadJobs = (): UseDownloadJobsResult => {
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  // Cache the notify-on-complete flag so we don't hit loadSettings() on every
  // download completion. Refreshed once per mount; users toggling the option
  // mid-session will see it apply on the next app launch (acceptable).
  const notifyOnCompleteRef = useRef(false);

  const reload = useCallback(() => {
    list()
      .then(setJobs)
      .catch((e) => console.error('list failed', e));
  }, []);

  const notify = useCallback(async (title: string, body: string) => {
    if (!notifyOnCompleteRef.current) return;
    try {
      const granted =
        (await isPermissionGranted()) || (await requestPermission()) === 'granted';
      if (granted) sendNotification({ title, body });
    } catch (e) {
      console.error('notify failed', e);
    }
  }, []);

  useEffect(() => {
    reload();
    loadSettings()
      .then((s) => {
        notifyOnCompleteRef.current = s.notifyOnDownloadComplete;
      })
      .catch(() => {});

    const unlisten = Promise.all([
      // Patch the matching job in place rather than re-fetching the full list
      // for every single yt-dlp progress tick (could be 5–10 events/sec/job).
      listen<ProgressPayload>('downloader:progress', (e) => {
        const { id, update } = e.payload;
        setJobs((prev) => {
          const idx = prev.findIndex((j) => j.id === id);
          if (idx === -1) return prev;
          const current = prev[idx];
          const nextProgress = update.percent / 100;
          const nextBytesDone = update.bytes_done ?? current.bytes_done;
          const nextBytesTotal = update.bytes_total ?? current.bytes_total;
          if (
            current.progress === nextProgress &&
            current.bytes_done === nextBytesDone &&
            current.bytes_total === nextBytesTotal
          ) {
            return prev;
          }
          const next = prev.slice();
          next[idx] = {
            ...current,
            progress: nextProgress,
            bytes_done: nextBytesDone,
            bytes_total: nextBytesTotal,
          };
          return next;
        });
      }),
      listen<{ id: number; path: string }>('downloader:completed', (e) => {
        reload();
        const name = e.payload.path.split('/').pop() ?? 'Download';
        notify('Download finished', name);
      }),
      listen<{ id: number }>('downloader:failed', () => {
        reload();
        notify('Download failed', 'See Downloads for details.');
      }),
    ]);
    return () => {
      unlisten.then((fns) => fns.forEach((f) => f())).catch(() => {});
    };
  }, [reload, notify]);

  const { active, completed } = useMemo(
    () => ({
      active: jobs.filter((j) => ACTIVE_STATUSES.has(j.status)),
      completed: jobs.filter((j) => COMPLETED_STATUSES.has(j.status)),
    }),
    [jobs]
  );

  return { jobs, active, completed, reload };
};
