import { IconButton } from '../../shared/ui/IconButton';
import { CloseIcon } from '../../shared/ui/icons';
import { ProgressBar } from '../../shared/ui/ProgressBar';
import { Spinner } from '../../shared/ui/Spinner';
import type { ConverterJob } from './api';

type JobRowProps = {
  job: ConverterJob;
  onCancel: (jobId: string) => void;
};

/// Active-job pill: filename + phase text + progress bar + cancel.
/// One row per running ffmpeg / whisper job. Mirrors the separator
/// JobRow shape so the popup feels homogeneous when both modules
/// have work in flight.
export function JobRow({ job, onCancel }: JobRowProps) {
  const percent = Math.round(job.progress * 100);
  const phase = phaseLabel(job);
  return (
    <div
      data-testid={`converter-job-${job.id}`}
      className="rounded-md border [border-color:var(--hairline)] p-3 [background:var(--bg-row-active)]"
    >
      <div className="flex items-center gap-3">
        <Spinner size={14} className="shrink-0 t-secondary" />
        <div className="flex-1 min-w-0">
          <div className="t-primary text-body truncate font-medium">
            {filename(job.input_path)}
          </div>
          <div className="t-tertiary text-meta">{phase}</div>
        </div>
        {job.kind === 'convert' && (
          <span className="t-secondary text-meta font-mono tabular-nums">{percent}%</span>
        )}
        <IconButton title="Cancel" onClick={() => onCancel(job.id)}>
          <CloseIcon size={13} />
        </IconButton>
      </div>
      {job.kind === 'convert' && (
        <ProgressBar
          value={job.progress}
          size="sm"
          className="mt-2"
          ariaLabel={`${phase} ${percent}%`}
        />
      )}
    </div>
  );
}

function phaseLabel(job: ConverterJob): string {
  if (job.status === 'queued') return 'Queued';
  if (job.kind === 'transcribe') return 'Transcribing';
  return job.preset_id ? `Converting · ${job.preset_id}` : 'Converting';
}

function filename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}
