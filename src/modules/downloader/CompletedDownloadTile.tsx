import { memo, useState } from 'react';
import { CloseIcon, PlayIcon, ReuseIcon } from '../../shared/ui/icons';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { PlatformBadge } from './PlatformBadge';
import type { DownloadJob } from './api';

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

const tileStyle = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.05)',
} as const;
const thumbStyle = { background: 'rgba(0,0,0,0.5)' } as const;
const hoverOverlayStyle = { background: 'rgba(0,0,0,0.4)' } as const;
const deleteButtonStyle = { background: 'rgba(0,0,0,0.55)' } as const;

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
      className={`group relative rounded-lg overflow-hidden ${failed ? 'cursor-default' : 'cursor-pointer'}`}
      style={tileStyle}
      onClick={onTileClick}
    >
      <div
        className="aspect-video relative"
        style={thumbStyle}
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
            className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
            style={hoverOverlayStyle}
          >
            <PlayIcon size={36} className="text-white" />
          </div>
        )}
        {failed && onRetry && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRetry(job.id);
            }}
            className="absolute inset-0 flex items-center justify-center gap-1.5 text-white opacity-0 group-hover:opacity-100 transition-opacity"
            style={hoverOverlayStyle}
            aria-label="Retry download"
            title={job.error ? `Retry — ${job.error}` : 'Retry download'}
          >
            <ReuseIcon size={16} />
            <span className="text-meta">Retry</span>
          </button>
        )}
        <button
          onClick={openDelete}
          className="absolute top-1 right-1 w-6 h-6 rounded-md items-center justify-center hidden group-hover:flex"
          style={deleteButtonStyle}
          aria-label="Delete"
        >
          <CloseIcon className="text-white" size={12} />
        </button>
      </div>
      <div className="px-2 py-1.5">
        <div className="flex items-center gap-1 mb-0.5">
          <PlatformBadge platform={job.platform} />
        </div>
        <div className="t-primary text-meta font-medium truncate">
          {job.title ?? (job.target_path?.split('/').pop() ?? job.url)}
        </div>
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
