import { CheckIcon, CloseIcon } from '../../shared/ui/icons';
import { Button } from '../../shared/ui/Button';
import { useToast } from '../../shared/ui/Toast';
import { PlatformBadge } from './PlatformBadge';
import { formatBytes, type DownloadJob } from './api';

interface CompletedDownloadRowProps {
  job: DownloadJob;
  zebra: boolean;
  onDelete: () => void;
  onPlay: () => void;
  onRetry: () => void;
}

const zebraStyle = { background: 'rgba(255,255,255,0.02)' } as const;
const successBadgeStyle = {
  background: 'rgba(40,200,64,0.14)',
  color: '#43D66B',
} as const;
const failBadgeStyle = {
  background: 'rgba(235,72,72,0.14)',
  color: '#FF6B6B',
} as const;

const isFailure = (status: DownloadJob['status']) =>
  status === 'failed' || status === 'cancelled';

export const CompletedDownloadRow = ({
  job,
  zebra,
  onDelete,
  onPlay,
  onRetry,
}: CompletedDownloadRowProps) => {
  const failed = isFailure(job.status);
  const { toast } = useToast();

  const reveal = async () => {
    if (!job.target_path) return;
    try {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(job.target_path);
    } catch (e) {
      console.error('reveal failed', e);
      toast({ title: 'Could not reveal file', description: String(e), variant: 'error' });
    }
  };

  return (
    <div className="flex items-center gap-3 px-3 py-2" style={zebra ? zebraStyle : undefined}>
      <div
        className="w-6 h-6 rounded flex items-center justify-center shrink-0"
        style={failed ? failBadgeStyle : successBadgeStyle}
      >
        {failed ? <CloseIcon size={12} /> : <CheckIcon size={12} />}
      </div>
      <PlatformBadge platform={job.platform} />
      <span className="t-primary text-body truncate flex-1">
        {job.target_path ? job.target_path.split('/').pop() : (job.title ?? job.url)}
      </span>
      {job.bytes_total && (
        <span className="t-tertiary text-meta font-mono">{formatBytes(job.bytes_total)}</span>
      )}
      {job.target_path && !failed && (
        <Button size="sm" variant="soft" tone="accent" onClick={onPlay}>
          Play
        </Button>
      )}
      {failed && (
        <Button
          size="sm"
          variant="soft"
          tone="accent"
          onClick={onRetry}
          title={job.error ?? 'Retry download'}
        >
          Retry
        </Button>
      )}
      {job.target_path && (
        <Button size="sm" variant="soft" onClick={reveal}>
          Reveal
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        tone="danger"
        shape="square"
        aria-label="Delete"
        title="Delete"
        onClick={onDelete}
      >
        ×
      </Button>
    </div>
  );
};
