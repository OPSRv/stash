import { useCallback, useEffect, useState } from 'react';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { SectionLabel } from '../../shared/ui/SectionLabel';
import { VideoPlayer } from '../../shared/ui/VideoPlayer';
import { ActiveDownloadRow } from './ActiveDownloadRow';
import { CompletedDownloadRow } from './CompletedDownloadRow';
import { CompletedDownloadTile } from './CompletedDownloadTile';
import { DetectedPreviewCard } from './DetectedPreviewCard';
import { DownloadUrlBar } from './DownloadUrlBar';
import { DropOverlay } from './DropOverlay';
import { QualityPicker } from './QualityPicker';
import { Spinner } from '../../shared/ui/Spinner';
import { Button } from '../../shared/ui/Button';
import { SegmentedControl } from '../../shared/ui/SegmentedControl';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { EmptyState } from '../../shared/ui/EmptyState';
import { useToast } from '../../shared/ui/Toast';
import { useAnnounce } from '../../shared/ui/LiveRegion';
import { useSuppressibleConfirm } from '../../shared/hooks/useSuppressibleConfirm';
import {
  DEFAULT_QUALITY_OPTIONS,
  DETECT_SLOW_HINT_THRESHOLD_SEC,
  SUPPORTED_VIDEO_URL,
} from './downloads.constants';
import { useDownloadJobs } from './useDownloadJobs';
import { useUrlDropTarget } from './useUrlDropTarget';
import { useVideoDetect } from './useVideoDetect';
import {
  cancel,
  clearCompleted,
  deleteJob,
  formatDuration,
  pause,
  resume,
  retry,
  start,
  type QualityOption,
} from './api';

type CompletedView = 'list' | 'grid';

const durationBadgeStyle = { background: 'rgba(0,0,0,0.55)' } as const;
const errorBannerStyle = {
  background: 'var(--color-danger-bg)',
  color: 'var(--color-danger-fg)',
  border: '1px solid var(--color-danger-border)',
} as const;

export const DownloadsShell = () => {
  const [url, setUrl] = useState('');
  const [pickedFormat, setPickedFormat] = useState<QualityOption | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [completedView, setCompletedView] = useState<CompletedView>('grid');
  const [clearCompletedOpen, setClearCompletedOpen] = useState(false);
  const cancelConfirm = useSuppressibleConfirm<number>('downloader.cancel');
  const { toast } = useToast();
  const { announce } = useAnnounce();

  const detectState = useVideoDetect();
  const { detecting, elapsedSec, quick, detected, error: detectError, run, cancel: cancelDetect, reset } = detectState;
  const { active, completed, reload } = useDownloadJobs();

  // Quality options we actually render: real ones from the full detect when
  // available, otherwise the generic ladder so the user can pick + download
  // immediately after pasting a URL instead of waiting ~20 s for
  // `yt-dlp --dump-json`. The runner resolves format at download time from
  // `height` + `kind`, so placeholder `format_id`s on the defaults are fine.
  const qualityOptions: QualityOption[] =
    detected?.qualities && detected.qualities.length > 0
      ? detected.qualities
      : (DEFAULT_QUALITY_OPTIONS as unknown as QualityOption[]);

  // When the full detect resolves, swap the user's selected placeholder for
  // the matching real option (same height + kind) so the eventual Download
  // click carries the richer format_id. If they haven't picked yet, seed to
  // 1080p by default.
  useEffect(() => {
    if (!detected) return;
    setPickedFormat((prev) => {
      if (!prev) {
        return (
          detected.qualities.find((q) => q.kind === 'video' && q.height === 1080) ??
          detected.qualities[0] ??
          null
        );
      }
      const matched = detected.qualities.find(
        (q) => q.kind === prev.kind && q.height === prev.height
      );
      return matched ?? prev;
    });
  }, [detected]);

  const runDetect = useCallback(
    (value: string) => {
      setPickedFormat(null);
      void run(value);
    },
    [run]
  );

  // On mount: if clipboard holds a supported URL, auto-fill and detect.
  useEffect(() => {
    (async () => {
      try {
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

  const onUrlDropped = useCallback(
    (dropped: string) => {
      setUrl(dropped);
      runDetect(dropped);
    },
    [runDetect]
  );

  const { isDragOver, handlers: dropHandlers } = useUrlDropTarget(onUrlDropped);

  const startDownload = useCallback(async () => {
    const chosen = pickedFormat ?? qualityOptions[0] ?? null;
    if (!url.trim() || !chosen) return;
    // Prefer full-detect metadata if it already landed; otherwise use the
    // oEmbed quick preview. Neither is required — the backend can download
    // from just a URL + height/kind.
    const title = detected?.info.title ?? quick?.preview.title ?? null;
    const thumbnail = detected?.info.thumbnail ?? quick?.preview.thumbnail ?? null;
    try {
      await start({
        url: url.trim(),
        title,
        thumbnail,
        format_id: chosen.format_id.startsWith('auto-') ? null : chosen.format_id,
        height: chosen.height ?? null,
        kind: chosen.kind,
      });
      reset();
      setPickedFormat(null);
      setUrl('');
      reload();
      announce('Download started');
      toast({ title: 'Download started', variant: 'success', durationMs: 2500 });
    } catch (e) {
      console.error('start failed', e);
      toast({
        title: 'Could not start download',
        description: String(e),
        variant: 'error',
        action: { label: 'Retry', onClick: () => void startDownload() },
      });
    }
  }, [detected, quick, pickedFormat, qualityOptions, url, reset, reload, toast, announce]);

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
  const handleCancelJob = useCallback(
    (id: number) => () => cancelConfirm.request(id, performCancel),
    [cancelConfirm, performCancel]
  );
  const handlePauseJob = useCallback(
    (id: number) => () =>
      pause(id).then(() => {
        reload();
        announce('Download paused');
      }),
    [reload, announce]
  );
  const handleResumeJob = useCallback(
    (id: number) => () =>
      resume(id).then(() => {
        reload();
        announce('Download resumed');
      }),
    [reload, announce]
  );
  const handleDeleteJob = useCallback(
    (id: number) => () =>
      deleteJob(id).then(() => {
        reload();
        announce('Download removed');
      }),
    [reload, announce]
  );
  const handleRetryJob = useCallback(
    (id: number) => () =>
      retry(id)
        .then(() => {
          reload();
          toast({ title: 'Retrying download', variant: 'default', durationMs: 2500 });
        })
        .catch((e) => {
          console.error('retry failed', e);
          toast({ title: 'Retry failed', description: String(e), variant: 'error' });
        }),
    [reload, toast]
  );
  const handlePlay = useCallback(
    (targetPath: string | null) => () => {
      if (targetPath) setPlaying(targetPath);
    },
    []
  );

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
        detecting={detecting}
        elapsedSec={elapsedSec}
        onUrlChange={setUrl}
        onDetect={() => runDetect(url)}
        onCancel={cancelDetect}
      />

      {detecting && elapsedSec > DETECT_SLOW_HINT_THRESHOLD_SEC && (
        <div className="mx-4 mt-1 t-tertiary text-meta">
          YouTube and a few other sites can take 20–40 seconds on the first
          fetch; subsequent detects of the same URL are instant.
        </div>
      )}

      {(detected || quick) && (
        <DetectedPreviewCard
          platform={detected?.platform ?? quick!.platform}
          title={detected?.info.title ?? quick!.preview.title}
          uploader={detected?.info.uploader ?? quick!.preview.uploader}
          thumbnail={detected?.info.thumbnail ?? quick!.preview.thumbnail}
          overlayBadge={
            detected?.info.duration ? (
              <div
                className="absolute bottom-1 right-1 text-[10px] font-mono text-white/90 px-1 rounded"
                style={durationBadgeStyle}
              >
                {formatDuration(detected.info.duration)}
              </div>
            ) : undefined
          }
          footerText={
            detected
              ? `${detected.qualities.length} quality options`
              : (
                <span className="flex items-center gap-1.5">
                  <Spinner size={12} /> Fetching exact sizes — pick a quality and download now
                </span>
              )
          }
          trailing={
            <QualityPicker
              options={qualityOptions}
              selected={pickedFormat ?? qualityOptions[0] ?? null}
              onSelect={setPickedFormat}
              onDownload={startDownload}
            />
          }
        />
      )}

      {detectError && (
        <div
          className="mx-4 mt-3 t-tertiary text-meta px-3 py-2 rounded-md"
          style={errorBannerStyle}
        >
          {detectError}
        </div>
      )}

      <div className="flex-1 overflow-y-auto nice-scroll">
        {active.length > 0 && (
          <>
            <div className="px-4 pt-3 pb-1 flex items-center justify-between">
              <SectionLabel>Active · {active.length}</SectionLabel>
            </div>
            {active.map((job) => (
              <ActiveDownloadRow
                key={job.id}
                job={job}
                onCancel={handleCancelJob(job.id)}
                onPause={handlePauseJob(job.id)}
                onResume={handleResumeJob(job.id)}
              />
            ))}
          </>
        )}

        {completed.length > 0 && (
          <>
            <div className="px-4 pt-4 pb-1 flex items-center justify-between">
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
              />
            ) : (
              <CompletedGrid
                jobs={completed}
                onPlay={handlePlay}
                onDelete={handleDeleteJob}
              />
            )}
          </>
        )}

        {active.length === 0 && completed.length === 0 && !detected && (
          <EmptyState
            title="No downloads yet"
            description="Paste a video URL above or drop one in — YouTube, TikTok, Instagram, X, Reddit, Vimeo, Twitch and more."
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

interface ListProps {
  jobs: ReturnType<typeof useDownloadJobs>['completed'];
  onPlay: (path: string | null) => () => void;
  onDelete: (id: number) => () => void;
  onRetry: (id: number) => () => void;
}

const completedListBorderStyle = {
  border: '1px solid rgba(255,255,255,0.05)',
} as const;

const CompletedList = ({ jobs, onPlay, onDelete, onRetry }: ListProps) => (
  <div className="mx-3 rounded-xl overflow-hidden" style={completedListBorderStyle}>
    {jobs.map((job, i) => (
      <CompletedDownloadRow
        key={job.id}
        job={job}
        zebra={i % 2 === 0}
        onDelete={onDelete(job.id)}
        onPlay={onPlay(job.target_path)}
        onRetry={onRetry(job.id)}
      />
    ))}
  </div>
);

interface GridProps {
  jobs: ReturnType<typeof useDownloadJobs>['completed'];
  onPlay: (path: string | null) => () => void;
  onDelete: (id: number) => () => void;
}

const CompletedGrid = ({ jobs, onPlay, onDelete }: GridProps) => (
  <div className="mx-3 grid grid-cols-4 gap-2">
    {jobs.map((job) => (
      <CompletedDownloadTile
        key={job.id}
        job={job}
        onPlay={onPlay(job.target_path)}
        onDelete={onDelete(job.id)}
      />
    ))}
  </div>
);
