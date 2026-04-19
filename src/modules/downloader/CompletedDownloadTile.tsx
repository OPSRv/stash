import { CloseIcon, PlayIcon } from '../../shared/ui/icons';
import { PlatformBadge } from './PlatformBadge';
import type { DownloadJob } from './api';

interface CompletedDownloadTileProps {
  job: DownloadJob;
  onPlay: () => void;
  onDelete: () => void;
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

export const CompletedDownloadTile = ({
  job,
  onPlay,
  onDelete,
}: CompletedDownloadTileProps) => {
  const failed = isFailure(job.status);

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete();
  };

  return (
    <div
      className="group relative rounded-lg overflow-hidden cursor-pointer"
      style={tileStyle}
      onClick={failed ? undefined : onPlay}
    >
      <div className="aspect-video relative" style={thumbStyle}>
        {job.thumbnail_url ? (
          <img src={job.thumbnail_url} alt="" className="w-full h-full object-cover" />
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
        <button
          onClick={handleDelete}
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
    </div>
  );
};
