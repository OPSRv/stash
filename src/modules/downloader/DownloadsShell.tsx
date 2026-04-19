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
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { useToast } from '../../shared/ui/Toast';
import { useAnnounce } from '../../shared/ui/LiveRegion';
import { DETECT_SLOW_HINT_THRESHOLD_SEC, SUPPORTED_VIDEO_URL } from './downloads.constants';
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
  background: 'rgba(235,72,72,0.08)',
  color: '#FF7878',
} as const;

export const DownloadsShell = () => {
  const [url, setUrl] = useState('');
  const [pickedFormat, setPickedFormat] = useState<QualityOption | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [completedView, setCompletedView] = useState<CompletedView>('grid');
  const [clearCompletedOpen, setClearCompletedOpen] = useState(false);
  const { toast } = useToast();
  const { announce } = useAnnounce();

  const detectState = useVideoDetect();
  const { detecting, elapsedSec, quick, detected, error: detectError, run, cancel: cancelDetect, reset } = detectState;
  const { active, completed, reload } = useDownloadJobs();

  // Keep the selected quality in sync with whatever the detect pipeline
  // last surfaced. Picking manually later overrides this.
  useEffect(() => {
    if (detected) setPickedFormat(detected.qualities[0] ?? null);
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
    if (!detected || !pickedFormat) return;
    try {
      await start({
        url: url.trim(),
        title: detected.info.title,
        thumbnail: detected.info.thumbnail,
        format_id: pickedFormat.format_id,
        height: pickedFormat.height ?? null,
        kind: pickedFormat.kind,
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
  }, [detected, pickedFormat, url, reset, reload, toast, announce]);

  const handleCancelJob = useCallback(
    (id: number) => () => cancel(id).then(reload),
    [reload]
  );
  const handlePauseJob = useCallback(
    (id: number) => () => pause(id).then(reload),
    [reload]
  );
  const handleResumeJob = useCallback(
    (id: number) => () => resume(id).then(reload),
    [reload]
  );
  const handleDeleteJob = useCallback(
    (id: number) => () => deleteJob(id).then(reload),
    [reload]
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
        const job = active[0];
        cancel(job.id)
          .then(() => {
            reload();
            announce('Download cancelled');
          })
          .catch((err) => toast({ title: 'Cancel failed', description: String(err), variant: 'error' }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, reload, toast, announce]);

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

      {quick && !detected && (
        <DetectedPreviewCard
          muted
          platform={quick.platform}
          title={quick.preview.title}
          uploader={quick.preview.uploader}
          thumbnail={quick.preview.thumbnail}
          footerText={
            <span className="flex items-center gap-1.5">
              <Spinner size={12} /> Resolving quality options…
            </span>
          }
        />
      )}

      {detected && (
        <DetectedPreviewCard
          platform={detected.platform}
          title={detected.info.title}
          uploader={detected.info.uploader}
          thumbnail={detected.info.thumbnail}
          overlayBadge={
            detected.info.duration ? (
              <div
                className="absolute bottom-1 right-1 text-[10px] font-mono text-white/90 px-1 rounded"
                style={durationBadgeStyle}
              >
                {formatDuration(detected.info.duration)}
              </div>
            ) : undefined
          }
          footerText={`${detected.qualities.length} quality options`}
          trailing={
            <QualityPicker
              options={detected.qualities}
              selected={pickedFormat}
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
                <div className="seg flex text-meta font-medium">
                  <button
                    onClick={() => setCompletedView('list')}
                    className={`px-2 py-0.5 rounded-md ${completedView === 'list' ? 'on' : ''}`}
                  >
                    List
                  </button>
                  <button
                    onClick={() => setCompletedView('grid')}
                    className={`px-2 py-0.5 rounded-md ${completedView === 'grid' ? 'on' : ''}`}
                  >
                    Grid
                  </button>
                </div>
                <button
                  onClick={() => setClearCompletedOpen(true)}
                  className="t-tertiary text-meta hover:t-secondary"
                >
                  Clear
                </button>
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
          <div className="h-full flex items-center justify-center t-tertiary text-meta pt-24">
            No downloads yet — paste a URL above.
          </div>
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
