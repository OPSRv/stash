import { CloseIcon, PauseIcon, PlayIcon } from '../../shared/ui/icons';
import { Card } from '../../shared/ui/Card';
import { IconButton } from '../../shared/ui/IconButton';
import { PlatformBadge } from './PlatformBadge';
import { formatBytes, type DownloadJob } from './api';
import { STATUS_LABELS } from './downloads.constants';

interface ActiveDownloadRowProps {
  job: DownloadJob;
  onCancel: () => void;
  onPause: () => void;
  onResume: () => void;
}

const thumbStyle = { background: 'rgba(0,0,0,0.4)' } as const;
const trackStyle = { background: 'rgba(255,255,255,0.08)' } as const;
const inactiveFillStyle = { background: 'rgba(255,255,255,0.35)' } as const;

export const ActiveDownloadRow = ({
  job,
  onCancel,
  onPause,
  onResume,
}: ActiveDownloadRowProps) => {
  // Clamp to [0, 100] — yt-dlp occasionally emits progress values above 1
  // when a post-processing step bumps bytes_done past bytes_total, and a
  // "104%" readout under the play icon looks like a bug.
  const progressPct = Math.max(0, Math.min(100, Math.round(job.progress * 100)));
  const bytesLabel =
    job.bytes_done && job.bytes_total ? formatBytes(job.bytes_done) : null;
  const isPaused = job.status === 'paused';

  return (
    <Card
      padding="md"
      rounded="xl"
      className="mx-3 my-1 flex items-center gap-3"
    >
      <div
        className="w-13 h-8 rounded-md shrink-0 overflow-hidden"
        style={thumbStyle}
      >
        {job.thumbnail_url && (
          <img
            src={job.thumbnail_url}
            alt=""
            className="w-full h-full object-cover"
          />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <PlatformBadge platform={job.platform} />
          <span className="t-primary text-body truncate font-medium">
            {job.title ?? job.url}
          </span>
        </div>
        <div className="h-1 rounded-full overflow-hidden" style={trackStyle}>
          <div
            className={`h-full rounded-full ${job.status === 'active' ? 'prog-fill' : ''}`}
            style={
              job.status === 'active'
                ? { width: `${progressPct}%` }
                : { width: `${progressPct}%`, ...inactiveFillStyle }
            }
          />
        </div>
        <div className="flex items-center justify-between mt-1.5">
          <span className="t-secondary text-meta font-mono">
            {progressPct}% · {bytesLabel ?? STATUS_LABELS[job.status]}
            {job.bytes_total ? ` / ${formatBytes(job.bytes_total)}` : ''}
          </span>
          <span className="t-tertiary text-meta">{STATUS_LABELS[job.status]}</span>
        </div>
      </div>
      <div className="shrink-0 flex items-center gap-1">
        <IconButton
          onClick={isPaused ? onResume : onPause}
          title={isPaused ? 'Resume (Space)' : 'Pause (Space)'}
          stopPropagation={false}
        >
          {isPaused ? <PlayIcon size={13} /> : <PauseIcon size={13} />}
        </IconButton>
        <IconButton
          onClick={onCancel}
          title="Cancel (⌫)"
          tone="danger"
          stopPropagation={false}
        >
          <CloseIcon size={13} />
        </IconButton>
      </div>
    </Card>
  );
};
