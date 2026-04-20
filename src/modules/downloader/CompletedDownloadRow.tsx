import { memo, useState } from 'react';
import { CheckIcon, CloseIcon, NoteIcon } from '../../shared/ui/icons';
import { Button } from '../../shared/ui/Button';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { useToast } from '../../shared/ui/Toast';
import { PlatformBadge } from './PlatformBadge';
import { formatBytes, type DownloadJob } from './api';

interface CompletedDownloadRowProps {
  job: DownloadJob;
  zebra: boolean;
  /// `purgeFile` is true when the user opted to also delete the downloaded
  /// file from disk (not just drop the history row). Callbacks take the
  /// row's job so parents can keep stable references and let memo skip
  /// unrelated re-renders.
  onDelete: (id: number, purgeFile: boolean) => void;
  onPlay: (path: string | null) => void;
  onRetry: (id: number) => void;
  onExtractSubtitles?: (job: DownloadJob) => void;
  /// Lets the parent disable the CC button globally while another extraction
  /// is running — yt-dlp is single-ish, and we don't want overlapping spawns.
  extractingSubtitles?: boolean;
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

const CompletedDownloadRowImpl = ({
  job,
  zebra,
  onDelete,
  onPlay,
  onRetry,
  onExtractSubtitles,
  extractingSubtitles = false,
}: CompletedDownloadRowProps) => {
  const failed = isFailure(job.status);
  const { toast } = useToast();
  const [deleteOpen, setDeleteOpen] = useState(false);

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

  const openExternally = async () => {
    if (!job.target_path) return;
    try {
      const { openPath } = await import('@tauri-apps/plugin-opener');
      await openPath(job.target_path);
    } catch (e) {
      console.error('open failed', e);
      toast({ title: 'Could not open file', description: String(e), variant: 'error' });
    }
  };

  const canPurge = Boolean(job.target_path) && !failed;

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
        <Button size="sm" variant="soft" tone="accent" onClick={() => onPlay(job.target_path)}>
          Play
        </Button>
      )}
      {failed && (
        <Button
          size="sm"
          variant="soft"
          tone="accent"
          onClick={() => onRetry(job.id)}
          title={job.error ?? 'Retry download'}
        >
          Retry
        </Button>
      )}
      {onExtractSubtitles && !failed && (
        <Button
          size="sm"
          variant="soft"
          onClick={() => onExtractSubtitles(job)}
          disabled={extractingSubtitles}
          title="Save subtitles to Notes"
          aria-label="Save subtitles to Notes"
        >
          <NoteIcon size={12} />
          <span className="ml-1">CC</span>
        </Button>
      )}
      {job.target_path && !failed && (
        <Button
          size="sm"
          variant="soft"
          onClick={openExternally}
          title="Open with the system default app"
        >
          Open
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
        onClick={() => setDeleteOpen(true)}
      >
        ×
      </Button>
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

/// Completed-download rows live inside a long list that re-renders whenever
/// a single job's progress ticks. Skipping rows whose visible inputs are
/// unchanged is a free win — the cost is just a shallow equality check.
export const CompletedDownloadRow = memo(CompletedDownloadRowImpl, (a, b) =>
  a.job === b.job &&
  a.zebra === b.zebra &&
  a.extractingSubtitles === b.extractingSubtitles &&
  a.onDelete === b.onDelete &&
  a.onPlay === b.onPlay &&
  a.onRetry === b.onRetry &&
  a.onExtractSubtitles === b.onExtractSubtitles,
);
