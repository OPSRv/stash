import { IconButton } from '../../shared/ui/IconButton';
import { CloseIcon } from '../../shared/ui/icons';
import { ProgressBar } from '../../shared/ui/ProgressBar';
import { Spinner } from '../../shared/ui/Spinner';
import type { SeparatorJob } from './api';

type JobRowProps = {
  job: SeparatorJob;
  onCancel: (jobId: string) => void;
};

const PHASE_LABELS: Record<string, string> = {
  starting: 'Starting',
  queued: 'Queued',
  'loading demucs': 'Loading Demucs',
  'decoding audio': 'Decoding audio',
  separating: 'Separating stems',
  'stems written': 'Stems written',
  'loading beatnet': 'Loading BeatNet',
  'detecting tempo': 'Detecting BPM',
  done: 'Done',
};

export function JobRow({ job, onCancel }: JobRowProps) {
  const percent = Math.round(job.progress * 100);
  const label = PHASE_LABELS[job.phase] ?? job.phase;
  return (
    <div
      data-testid={`job-${job.id}`}
      className="rounded-md border [border-color:var(--hairline)] p-3 [background:var(--bg-row-active)]"
    >
      <div className="flex items-center gap-3">
        <Spinner size={14} className="shrink-0 t-secondary" />
        <div className="flex-1 min-w-0">
          <div className="t-primary text-body truncate font-medium">
            {filename(job.input_path)}
          </div>
          <div className="t-tertiary text-meta">{label}</div>
        </div>
        <span className="t-secondary text-meta font-mono tabular-nums">{percent}%</span>
        <IconButton
          title="Cancel"
          onClick={() => onCancel(job.id)}
        >
          <CloseIcon size={13} />
        </IconButton>
      </div>
      <ProgressBar
        value={job.progress}
        size="sm"
        className="mt-2"
        ariaLabel={`${label} ${percent}%`}
      />
    </div>
  );
}

function filename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}
