import { useCallback, useEffect, useMemo, useState } from 'react';
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

const notifyIfEnabled = async (title: string, body: string) => {
  try {
    const settings = await loadSettings();
    if (!settings.notifyOnDownloadComplete) return;
    const granted =
      (await isPermissionGranted()) || (await requestPermission()) === 'granted';
    if (granted) sendNotification({ title, body });
  } catch (e) {
    console.error('notify failed', e);
  }
};

/// Subscribes to downloader events and keeps a derived {active, completed}
/// partition in sync. Also handles native notifications so the view layer
/// stays declarative.
export const useDownloadJobs = (): UseDownloadJobsResult => {
  const [jobs, setJobs] = useState<DownloadJob[]>([]);

  const reload = useCallback(() => {
    list()
      .then(setJobs)
      .catch((e) => console.error('list failed', e));
  }, []);

  useEffect(() => {
    reload();
    const unlisten = Promise.all([
      listen('downloader:progress', reload),
      listen<{ id: number; path: string }>('downloader:completed', (e) => {
        reload();
        const name = e.payload.path.split('/').pop() ?? 'Download';
        notifyIfEnabled('Download finished', name);
      }),
      listen<{ id: number }>('downloader:failed', () => {
        reload();
        notifyIfEnabled('Download failed', 'See Downloads for details.');
      }),
    ]);
    return () => {
      unlisten.then((fns) => fns.forEach((f) => f())).catch(() => {});
    };
  }, [reload]);

  const { active, completed } = useMemo(
    () => ({
      active: jobs.filter((j) => ACTIVE_STATUSES.has(j.status)),
      completed: jobs.filter((j) => COMPLETED_STATUSES.has(j.status)),
    }),
    [jobs]
  );

  return { jobs, active, completed, reload };
};
