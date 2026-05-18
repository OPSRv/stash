import { IconButton } from '../../shared/ui/IconButton';
import { RevealButton } from '../../shared/ui/RevealButton';
import { CloseIcon } from '../../shared/ui/icons';
import type { ConverterJob } from './api';

type CompletedRowProps = {
  job: ConverterJob;
  /// Called when the user wants the row gone. The shell decides whether
  /// to fire a confirm dialog first — completed rows own a file on disk
  /// we don't want to wipe without explicit consent.
  onRemove: (job: ConverterJob) => void;
};

/// Finished-job row: filename → output, plus reveal-in-Finder + remove.
/// `failed` / `cancelled` keep the same shape but render the error
/// inline so the user knows what went wrong.
export function CompletedRow({ job, onRemove }: CompletedRowProps) {
  const failed = job.status === 'failed';
  const cancelled = job.status === 'cancelled';
  return (
    <div
      data-testid={`converter-completed-${job.id}`}
      className="group flex items-center gap-3 rounded-md border [border-color:var(--hairline)] p-3"
      style={{
        background: failed
          ? 'rgba(239, 68, 68, 0.05)'
          : 'var(--bg-row)',
      }}
    >
      <div className="flex-1 min-w-0">
        <div className="t-primary text-body truncate font-medium">
          {filename(job.output_path || job.input_path)}
        </div>
        <div className="t-tertiary text-meta truncate">
          {statusLabel(job)} · from {filename(job.input_path)}
        </div>
        {failed && job.error && (
          <p className="text-meta mt-1" style={{ color: 'rgba(239, 68, 68, 0.95)' }}>
            {firstLine(job.error)}
          </p>
        )}
      </div>
      {!failed && !cancelled && job.output_path && (
        <RevealButton path={job.output_path} label="Reveal" />
      )}
      <IconButton
        title={
          job.status === 'completed' && job.output_path
            ? 'Delete file and remove from list'
            : 'Remove from list'
        }
        onClick={() => onRemove(job)}
      >
        <CloseIcon size={13} />
      </IconButton>
    </div>
  );
}

function statusLabel(job: ConverterJob): string {
  switch (job.status) {
    case 'completed':
      return job.kind === 'transcribe' ? 'Transcribed' : 'Converted';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return job.status;
  }
}

function filename(path: string): string {
  if (!path) return '';
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return i < 0 ? s : s.slice(0, i);
}
