import { useCallback, useEffect, useState } from 'react';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { SectionLabel } from '../../shared/ui/SectionLabel';
import { VideoPlayer } from '../../shared/ui/VideoPlayer';
import { ActiveDownloadRow } from './ActiveDownloadRow';
import { CompletedGrid } from './CompletedGrid';
import { CompletedList } from './CompletedList';
import { DetectSessionCard } from './DetectSessionCard';
import { DownloadUrlBar } from './DownloadUrlBar';
import { DropOverlay } from './DropOverlay';
import { Button } from '../../shared/ui/Button';
import { SegmentedControl } from '../../shared/ui/SegmentedControl';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { EmptyState } from '../../shared/ui/EmptyState';
import { useToast } from '../../shared/ui/Toast';
import { useAnnounce } from '../../shared/ui/LiveRegion';
import { useSuppressibleConfirm } from '../../shared/hooks/useSuppressibleConfirm';
import { SUPPORTED_VIDEO_URL, isLikelyDownloadUrl } from './downloads.constants';
import { useDownloadJobs } from './useDownloadJobs';
import { useUrlDropTarget } from './useUrlDropTarget';
import { useVideoDetect } from './useVideoDetect';
import { takePendingDownloaderUrl } from './pendingUrl';
import {
  cancel,
  clearCompleted,
  deleteJob,
  extractSubtitles,
  pause,
  resume,
  retry,
  start,
  type DownloadJob,
  type QualityOption,
} from './api';
import type { DetectSession } from './useVideoDetect';
import { notesCreate } from '../notes/api';

type CompletedView = 'list' | 'grid';

export const DownloadsShell = () => {
  const [url, setUrl] = useState('');
  const [playing, setPlaying] = useState<string | null>(null);
  const [completedView, setCompletedView] = useState<CompletedView>('grid');
  const [clearCompletedOpen, setClearCompletedOpen] = useState(false);
  const cancelConfirm = useSuppressibleConfirm<number>('downloader.cancel');
  const { toast } = useToast();
  const { announce } = useAnnounce();

  const { sessions, detecting, elapsedSec, run, cancel: cancelDetect, dismiss, clearAll } =
    useVideoDetect();
  const { active, completed, reload } = useDownloadJobs();

  const runDetect = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      if (!isLikelyDownloadUrl(trimmed)) {
        toast({
          title: 'Not a valid URL',
          description: 'Paste a link starting with http:// or https://.',
          variant: 'error',
          durationMs: 2000,
        });
        return;
      }
      run(trimmed);
    },
    [run, toast]
  );

  // On mount: if the shell stashed a URL for us while we were still lazy-
  // loading (the usual path when a download link lands in the clipboard and
  // PopupShell flips the tab), consume it first. Otherwise fall back to
  // peeking at the clipboard directly so a fresh popup still auto-fills.
  useEffect(() => {
    (async () => {
      try {
        const pending = takePendingDownloaderUrl();
        if (pending && SUPPORTED_VIDEO_URL.test(pending)) {
          setUrl(pending);
          runDetect(pending);
          return;
        }
        const text = await readText();
        const candidate = text?.trim() ?? '';
        if (candidate && SUPPORTED_VIDEO_URL.test(candidate)) {
          setUrl(candidate);
          runDetect(candidate);
        }
      } catch (e) {
        console.warn('clipboard read failed on mount', e);
      }
    })();
  }, [runDetect]);

  // PopupShell routes freshly-copied supported URLs here via CustomEvent so
  // the detect flow kicks in even when the Downloader tab is already mounted.
  useEffect(() => {
    const onPrefill = (e: Event) => {
      const candidate = (e as CustomEvent<string>).detail;
      if (typeof candidate !== 'string') return;
      const trimmed = candidate.trim();
      if (!trimmed || !SUPPORTED_VIDEO_URL.test(trimmed)) return;
      if (trimmed === url) return;
      setUrl(trimmed);
      runDetect(trimmed);
    };
    window.addEventListener('stash:downloader-prefill', onPrefill);
    return () => window.removeEventListener('stash:downloader-prefill', onPrefill);
  }, [runDetect, url]);

  const onUrlDropped = useCallback(
    (dropped: string) => {
      setUrl(dropped);
      runDetect(dropped);
    },
    [runDetect]
  );

  const { isDragOver, handlers: dropHandlers } = useUrlDropTarget(onUrlDropped);

  const startDownloadForSession = useCallback(
    async ({
      session,
      chosen,
    }: {
      session: DetectSession;
      chosen: QualityOption;
    }) => {
      const { detected, quick } = session;
      const title = detected?.info.title ?? quick?.preview.title ?? null;
      const thumbnail = detected?.info.thumbnail ?? quick?.preview.thumbnail ?? null;
      try {
        await start({
          url: session.url,
          title,
          thumbnail,
          format_id: chosen.format_id.startsWith('auto-') ? null : chosen.format_id,
          height: chosen.height ?? null,
          kind: chosen.kind,
        });
        dismiss(session.id);
        // Only clear the URL bar if it still matches this session's URL; a
        // fast-typing user might have pasted the next one already, and we
        // don't want to wipe their input.
        setUrl((prev) => (prev === session.url ? '' : prev));
        reload();
        announce('Download started');
        toast({ title: 'Download started', variant: 'success', durationMs: 2500 });
      } catch (e) {
        console.error('start failed', e);
        toast({
          title: 'Could not start download',
          description: String(e),
          variant: 'error',
          action: {
            label: 'Retry',
            onClick: () => void startDownloadForSession({ session, chosen }),
          },
        });
      }
    },
    [announce, dismiss, reload, toast]
  );

  const performCancel = useCallback(
    (id: number) => {
      cancel(id)
        .then(() => {
          reload();
          announce('Download cancelled');
        })
        .catch((err) =>
          toast({ title: 'Cancel failed', description: String(err), variant: 'error' }),
        );
    },
    [reload, toast, announce],
  );
  const handleCancelJob = (id: number) =>
    cancelConfirm.request(id, performCancel);
  const handlePauseJob = (id: number) =>
    pause(id).then(() => {
      reload();
      announce('Download paused');
    });
  const handleResumeJob = (id: number) =>
    resume(id).then(() => {
      reload();
      announce('Download resumed');
    });
  // Stable callback — the completed list/grid rows are React.memo, so
  // identity churn here would force every row to re-render on any shell
  // update (toast, resize, tab banner).
  const handleDeleteJob = useCallback(
    (id: number, purgeFile: boolean) =>
      deleteJob(id, purgeFile)
        .then(() => {
          reload();
          announce(purgeFile ? 'Download and file deleted' : 'Download removed');
        })
        .catch((e) => {
          console.error('delete failed', e);
          toast({
            title: purgeFile ? 'Delete failed' : 'Remove failed',
            description: String(e),
            variant: 'error',
          });
        }),
    [reload, announce, toast],
  );
  const [extractingId, setExtractingId] = useState<number | null>(null);
  const handleExtractSubtitles = useCallback(
    async (job: DownloadJob) => {
      if (extractingId != null) return;
      setExtractingId(job.id);
      try {
        const text = await extractSubtitles(job.id);
        const firstLine = text.split('\n').find((l) => l.trim()) ?? '';
        const title = job.title
          ? `Subtitles · ${job.title}`
          : firstLine.length > 60
            ? `Subtitles · ${firstLine.slice(0, 57).trimEnd()}…`
            : `Subtitles · ${firstLine || 'Untitled'}`;
        await notesCreate(title, text);
        toast({
          title: 'Subtitles saved to Notes',
          variant: 'success',
          action: {
            label: 'Open Notes',
            onClick: () =>
              window.dispatchEvent(new CustomEvent('stash:navigate', { detail: 'notes' })),
          },
        });
      } catch (e) {
        console.error('subtitle extraction failed', e);
        toast({
          title: 'Could not extract subtitles',
          description: String(e),
          variant: 'error',
        });
      } finally {
        setExtractingId(null);
      }
    },
    [extractingId, toast],
  );
  const handleRetryJob = useCallback(
    (id: number) =>
      retry(id)
        .then(() => {
          reload();
          toast({ title: 'Retrying download', variant: 'default', durationMs: 2500 });
        })
        .catch((e) => {
          console.error('retry failed', e);
          toast({ title: 'Retry failed', description: String(e), variant: 'error' });
        }),
    [reload, toast],
  );
  const handlePlay = useCallback((targetPath: string | null) => {
    if (targetPath) setPlaying(targetPath);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        return;
      }
      if (e.key === ' ' && active.length > 0) {
        e.preventDefault();
        const job = active[0];
        const fn = job.status === 'paused' ? resume : pause;
        fn(job.id)
          .then(reload)
          .catch((err) => toast({ title: 'Action failed', description: String(err), variant: 'error' }));
      } else if (e.key === 'Backspace' && active.length > 0) {
        e.preventDefault();
        cancelConfirm.request(active[0].id, performCancel);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, reload, toast, cancelConfirm, performCancel]);

  return (
    <div
      className="h-full flex flex-col relative"
      {...dropHandlers}
    >
      <DownloadUrlBar
        url={url}
        invalid={url.trim().length > 0 && !isLikelyDownloadUrl(url)}
        detecting={detecting}
        elapsedSec={elapsedSec}
        onUrlChange={setUrl}
        onDetect={() => runDetect(url)}
        onCancel={() => {
          // URL-bar Cancel = cancel the newest in-flight detect. Individual
          // cards own their own dismiss for the rest of the queue.
          const latest = [...sessions].reverse().find((s) => s.detecting);
          if (latest) cancelDetect(latest.id);
        }}
        onClear={() => {
          setUrl('');
          clearAll();
        }}
        canClear={url.trim().length > 0 || sessions.length > 0}
      />

      {sessions.map((session) => (
        <DetectSessionCard
          key={session.id}
          session={session}
          onDismiss={() => dismiss(session.id)}
          onCancel={() => cancelDetect(session.id)}
          onDownload={startDownloadForSession}
        />
      ))}

      <div className="flex-1 overflow-y-auto nice-scroll">
        {active.length > 0 && (
          <>
            <div className="px-4 pt-3 pb-1 flex items-center justify-between">
              <SectionLabel>Active · {active.length}</SectionLabel>
              {/* Keyboard hints aren't free UX — users have no way to know
                  Space/Backspace do anything here unless we tell them. The
                  text is muted so it doesn't fight the section label. */}
              <span className="t-tertiary text-meta flex items-center gap-1">
                <kbd className="kbd">Space</kbd>
                <span>pause</span>
                <span>·</span>
                <kbd className="kbd">⌫</kbd>
                <span>cancel</span>
              </span>
            </div>
            {active.map((job) => (
              <ActiveDownloadRow
                key={job.id}
                job={job}
                onCancel={() => handleCancelJob(job.id)}
                onPause={() => handlePauseJob(job.id)}
                onResume={() => handleResumeJob(job.id)}
              />
            ))}
          </>
        )}

        {completed.length > 0 && (
          <>
            <div className="px-4 pt-3 pb-2 flex items-center justify-between">
              <SectionLabel>Completed</SectionLabel>
              <div className="flex items-center gap-2">
                <SegmentedControl
                  size="sm"
                  ariaLabel="Completed view"
                  value={completedView}
                  onChange={setCompletedView}
                  options={[
                    { value: 'list', label: 'List' },
                    { value: 'grid', label: 'Grid' },
                  ]}
                />
                <Button size="xs" variant="ghost" onClick={() => setClearCompletedOpen(true)}>
                  Clear
                </Button>
              </div>
            </div>
            {completedView === 'list' ? (
              <CompletedList
                jobs={completed}
                onPlay={handlePlay}
                onDelete={handleDeleteJob}
                onRetry={handleRetryJob}
                onExtractSubtitles={handleExtractSubtitles}
                extractingId={extractingId}
              />
            ) : (
              <CompletedGrid
                jobs={completed}
                onPlay={handlePlay}
                onDelete={handleDeleteJob}
                onRetry={handleRetryJob}
              />
            )}
          </>
        )}

        {active.length === 0 &&
          completed.length === 0 &&
          sessions.length === 0 &&
          !url.trim() && (
            <EmptyState
              title="No downloads yet"
              description="Paste a video URL above, drop one from your browser, or tap Paste — YouTube, TikTok, Instagram, X, Reddit, Vimeo, Twitch and more."
              action={
                <Button
                  size="sm"
                  variant="soft"
                  tone="accent"
                  onClick={async () => {
                    try {
                      const text = (await readText())?.trim();
                      if (!text) {
                        toast({
                          title: 'Clipboard is empty',
                          description: 'Copy a video URL first, then try again.',
                          variant: 'default',
                          durationMs: 1600,
                        });
                        return;
                      }
                      setUrl(text);
                      runDetect(text);
                    } catch (e) {
                      toast({
                        title: 'Couldn\u2019t read clipboard',
                        description: String(e),
                        variant: 'error',
                      });
                    }
                  }}
                >
                  Paste from clipboard
                </Button>
              }
            />
          )}
        <div className="h-6" />
      </div>

      {playing && <VideoPlayer src={playing} onClose={() => setPlaying(null)} />}
      {isDragOver && <DropOverlay />}
      <ConfirmDialog
        open={clearCompletedOpen}
        title="Clear completed downloads?"
        description="Files on disk are not removed. Only the history entries are cleared."
        confirmLabel="Clear"
        tone="danger"
        onConfirm={() => {
          setClearCompletedOpen(false);
          clearCompleted()
            .then(() => {
              reload();
              toast({ title: 'Completed list cleared', variant: 'success' });
            })
            .catch((e) =>
              toast({ title: 'Clear failed', description: String(e), variant: 'error' }),
            );
        }}
        onCancel={() => setClearCompletedOpen(false)}
      />
      <ConfirmDialog
        open={cancelConfirm.open}
        title="Cancel this download?"
        description="The in-progress file will be removed and the job stopped."
        confirmLabel="Cancel download"
        cancelLabel="Keep downloading"
        tone="danger"
        suppressibleLabel="Don't ask again"
        onConfirm={(suppress) => cancelConfirm.confirm(!!suppress)}
        onCancel={cancelConfirm.cancel}
      />
    </div>
  );
};

