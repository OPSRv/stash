import { memo, useCallback, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { CloseIcon, PlayIcon, ReuseIcon } from '../../shared/ui/icons';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { Tooltip } from '../../shared/ui/Tooltip';
import { TranscriptArea } from '../../shared/ui/TranscriptArea';
import { useTranscription, type TranscriptionHandlers } from '../../shared/hooks/useTranscription';
import { extOf } from '../../shared/util/fileKind';
import { PlatformBadge } from './PlatformBadge';
import { list, setTranscription, transcribeJob } from './api';
import type { DownloadJob } from './api';

const AUDIO_EXTS = new Set(['mp3', 'm4a', 'wav', 'ogg', 'opus', 'flac', 'aac', 'aiff', 'aif']);

export const isAudioJob = (job: DownloadJob): boolean => {
  if (job.target_path) {
    return AUDIO_EXTS.has(extOf(job.target_path));
  }
  return false;
};

interface CompletedDownloadTileProps {
  job: DownloadJob;
  onPlay: (path: string | null) => void;
  /// `purgeFile=true` means the user also asked to delete the file from disk.
  /// The tile shows a confirm dialog with an opt-in checkbox, mirroring the
  /// list row so both views can fully remove a download. Callbacks receive
  /// the job's id/path so parents can pass stable references.
  onDelete: (id: number, purgeFile: boolean) => void;
  /// Retry a failed/cancelled download. Grid view renders a retry button on
  /// failed tiles so the user doesn't have to flip to list view to recover.
  onRetry?: (id: number) => void;
}

const isFailure = (status: DownloadJob['status']) =>
  status === 'failed' || status === 'cancelled';

const CompletedDownloadTileImpl = ({
  job,
  onPlay,
  onDelete,
  onRetry,
}: CompletedDownloadTileProps) => {
  const failed = isFailure(job.status);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const canPurge = Boolean(job.target_path) && !failed;
  const showTranscript = job.status === 'completed' && isAudioJob(job);

  // Stable subscribe fn for useTranscription — listens to the three
  // downloader transcription events filtered to this job's id.
  const subscribe = useCallback(
    (handlers: TranscriptionHandlers) => {
      let cancelled = false;
      const unlisteners: Array<() => void> = [];

      Promise.all([
        listen<{ id: number }>('downloader:transcribing', (e) => {
          if (!cancelled && e.payload.id === job.id) handlers.onStart();
        }),
        listen<{ id: number }>('downloader:job_updated', async (e) => {
          if (cancelled || e.payload.id !== job.id) return;
          const jobs = await list();
          const updated = jobs.find((j) => j.id === job.id);
          if (updated?.transcription != null) handlers.onDone(updated.transcription);
        }),
        listen<{ id: number; error: string }>('downloader:transcribe_failed', (e) => {
          if (!cancelled && e.payload.id === job.id) handlers.onFailed(e.payload.error);
        }),
      ]).then((fns) => {
        if (!cancelled) unlisteners.push(...fns);
        else fns.forEach((f) => f());
      });

      return () => {
        cancelled = true;
        unlisteners.forEach((f) => f());
      };
    },
    // job.id is stable for the lifetime of a tile
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [job.id],
  );

  const { transcript, status: transcribeStatus, failed: transcribeFailed, transcribe } =
    useTranscription({
      initial: job.transcription,
      start: () => transcribeJob(job.id),
      subscribe,
    });

  const openDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteOpen(true);
  };

  const onTileClick = () => {
    if (failed) return; // retry is the only meaningful action on a failed tile
    onPlay(job.target_path);
  };

  return (
    <div
      className={`group relative rounded-lg overflow-hidden bg-white/[0.03] border border-white/[0.05] ${failed ? 'cursor-default' : 'cursor-pointer'}`}
      onClick={onTileClick}
    >
      <div
        className="aspect-video relative bg-black/50"
        title={failed ? job.error ?? 'Download failed' : undefined}
      >
        {job.thumbnail_url ? (
          <img
            src={job.thumbnail_url}
            alt=""
            className={`w-full h-full object-cover ${failed ? 'opacity-40' : ''}`}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center t-tertiary text-meta">
            {failed ? 'Failed' : 'No preview'}
          </div>
        )}
        {!failed && (
          <div
            className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/40"
          >
            <PlayIcon size={36} className="text-white" />
          </div>
        )}
        {failed && onRetry && (
          <Tooltip label={job.error ? `Retry — ${job.error}` : 'Retry download'}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRetry(job.id);
              }}
              className="absolute inset-0 flex items-center justify-center gap-1.5 text-white opacity-0 group-hover:opacity-100 transition-opacity bg-black/40"
              aria-label="Retry download"
            >
              <ReuseIcon size={16} />
              <span className="text-meta">Retry</span>
            </button>
          </Tooltip>
        )}
        <Tooltip label="Delete">
          <button
            onClick={openDelete}
            className="absolute top-1 right-1 w-6 h-6 rounded-md items-center justify-center hidden group-hover:flex bg-black/[0.55]"
            aria-label="Delete"
          >
            <CloseIcon className="text-white" size={12} />
          </button>
        </Tooltip>
      </div>
      <div className="px-2 py-1.5">
        <div className="flex items-center gap-1 mb-0.5">
          <PlatformBadge platform={job.platform} />
        </div>
        <div className="t-primary text-meta font-medium truncate">
          {job.title ?? (job.target_path?.split('/').pop() ?? job.url)}
        </div>
        {showTranscript && (
          <TranscriptArea
            transcript={transcript}
            transcribing={transcribeStatus === 'running'}
            failed={transcribeFailed}
            onTranscribe={transcribe}
            onRetry={transcribe}
            onEdit={(t) => setTranscription(job.id, t)}
            className="mt-1.5"
            labels={{
              transcribe: 'Transcribe audio',
              transcribing: 'Transcribing…',
              failed: '⚠ Transcription failed',
              retry: 'Retry',
            }}
          />
        )}
      </div>
      <ConfirmDialog
        open={deleteOpen}
        title="Delete this download?"
        description={
          canPurge
            ? 'Removes the entry from history. Tick the box to also delete the file from disk.'
            : 'Removes the entry from history.'
        }
        confirmLabel="Delete"
        tone="danger"
        suppressibleLabel={canPurge ? 'Also delete the downloaded file' : undefined}
        onConfirm={(alsoPurge) => {
          setDeleteOpen(false);
          onDelete(job.id, Boolean(canPurge && alsoPurge));
        }}
        onCancel={() => setDeleteOpen(false)}
      />
    </div>
  );
};

/// Tiles scroll in a grid that re-renders whenever any job in the list
/// ticks (download progress, transient hover state). Memoising skips tiles
/// whose own job snapshot hasn't changed.
export const CompletedDownloadTile = memo(CompletedDownloadTileImpl, (a, b) =>
  a.job === b.job &&
  a.onPlay === b.onPlay &&
  a.onDelete === b.onDelete &&
  a.onRetry === b.onRetry,
);
