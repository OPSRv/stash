import { useCallback, useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import * as api from './api';
import { DropZone } from './DropZone';
import { JobRow } from './JobRow';
import { CompletedRow } from './CompletedRow';

type ShellState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'not-installed' }
  | { kind: 'ready'; status: api.SeparatorStatus };

export function SeparatorShell() {
  const [shell, setShell] = useState<ShellState>({ kind: 'loading' });
  const [jobs, setJobs] = useState<api.SeparatorJob[]>([]);
  const [pendingFile, setPendingFile] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const refreshStatus = useCallback(() => {
    api
      .status()
      .then((s) => setShell(s.ready ? { kind: 'ready', status: s } : { kind: 'not-installed' }))
      .catch((e) => setShell({ kind: 'error', message: String(e) }));
  }, []);

  useEffect(() => {
    refreshStatus();
    api.listJobs().then(setJobs).catch(() => undefined);
  }, [refreshStatus]);

  useEffect(() => {
    const offJobP = listen<api.SeparatorJob>('separator:job', (e) => {
      setJobs((prev) => upsertJob(prev, e.payload));
    });
    const offDlP = listen<api.SeparatorDownloadEvent>('separator:download', () => {
      refreshStatus();
    });
    return () => {
      offJobP.then((f) => f()).catch(() => undefined);
      offDlP.then((f) => f()).catch(() => undefined);
    };
  }, [refreshStatus]);

  // Cross-module handoff from `downloader`. The emitter side is wired
  // in Task #9 (CompletedDownloadRow), so this listener is the standing
  // contract: any module that fires `stash:navigate` with detail
  // `{ tabId: 'separator', file }` will pre-fill our run.
  useEffect(() => {
    const onNav = (ev: Event) => {
      const detail = (ev as CustomEvent<{ tabId?: string; file?: string }>).detail;
      if (detail?.tabId !== 'separator' || !detail.file) return;
      setPendingFile(detail.file);
    };
    window.addEventListener('stash:navigate', onNav as EventListener);
    return () => window.removeEventListener('stash:navigate', onNav as EventListener);
  }, []);

  const startJob = useCallback(
    async (path: string, outputDir?: string) => {
      setSubmitError(null);
      setPendingFile(null);
      try {
        await api.run({ inputPath: path, outputDir });
      } catch (e) {
        setSubmitError(String(e));
      }
    },
    [],
  );

  // When a downloader hand-off arrives while we're already mounted and
  // ready, kick the run automatically. The `pendingFile` only stays
  // around long enough to render once on the empty-state DropZone.
  useEffect(() => {
    if (shell.kind !== 'ready' || !pendingFile) return;
    void startJob(pendingFile, shell.status.default_output_dir);
  }, [pendingFile, shell, startJob]);

  const cancelJob = useCallback((id: string) => {
    api.cancel(id).catch((e) => setSubmitError(String(e)));
  }, []);

  const removeJob = useCallback((id: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== id));
  }, []);

  const clearAllCompleted = useCallback(async () => {
    try {
      await api.clearCompleted();
      setJobs((prev) =>
        prev.filter(
          (j) => j.status === 'queued' || j.status === 'running',
        ),
      );
    } catch (e) {
      setSubmitError(String(e));
    }
  }, []);

  const active = useMemo(
    () => jobs.filter((j) => j.status === 'queued' || j.status === 'running'),
    [jobs],
  );
  const done = useMemo(
    () =>
      jobs.filter(
        (j) =>
          j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled',
      ),
    [jobs],
  );

  if (shell.kind === 'loading') {
    return (
      <div className="flex h-full items-center justify-center text-meta opacity-60">
        Завантаження…
      </div>
    );
  }
  if (shell.kind === 'error') {
    return (
      <div role="alert" className="p-6 text-body opacity-80">
        Помилка: {shell.message}
      </div>
    );
  }
  if (shell.kind === 'not-installed') {
    return (
      <div className="flex flex-col gap-3 p-6">
        <p className="text-body opacity-80">
          Розділення на стеми + визначення BPM ще не встановлено.
        </p>
        <p className="text-meta opacity-60">
          Перейдіть у Налаштування → Separator і завантажте Demucs+BeatNet
          (~360&nbsp;МБ для 6-stem). 4-stem fine-tuned моделі — ще +320&nbsp;МБ опційно.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <DropZone
        onPick={(p) => startJob(p, shell.status.default_output_dir)}
        pendingFile={pendingFile}
      />
      {submitError && (
        <p role="alert" className="text-meta text-red-300/80">
          {submitError}
        </p>
      )}
      {active.length > 0 && (
        <ul className="flex flex-col gap-2" data-testid="separator-active-jobs">
          {active.map((j) => (
            <li key={j.id}>
              <JobRow job={j} onCancel={cancelJob} />
            </li>
          ))}
        </ul>
      )}
      {done.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="separator-completed-jobs">
          <div className="flex items-center justify-between">
            <span className="text-meta opacity-60">Готово</span>
            <button
              type="button"
              onClick={clearAllCompleted}
              className="text-meta opacity-60 hover:opacity-100"
            >
              Очистити
            </button>
          </div>
          <ul className="flex flex-col gap-2">
            {done.map((j) => (
              <li key={j.id}>
                <CompletedRow job={j} onRemove={removeJob} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function upsertJob(prev: api.SeparatorJob[], next: api.SeparatorJob): api.SeparatorJob[] {
  const idx = prev.findIndex((j) => j.id === next.id);
  if (idx < 0) return [...prev, next];
  const copy = prev.slice();
  copy[idx] = next;
  return copy;
}

export default SeparatorShell;
