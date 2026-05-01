import { Button } from '../../shared/ui/Button';
import { ProgressBar } from '../../shared/ui/ProgressBar';
import type { SeparatorJob } from './api';

type JobRowProps = {
  job: SeparatorJob;
  onCancel: (jobId: string) => void;
};

const PHASE_LABELS: Record<string, string> = {
  starting: 'Початок',
  queued: 'У черзі',
  'loading demucs': 'Завантажую Demucs',
  'decoding audio': 'Декодую аудіо',
  separating: 'Розділяю стеми',
  'stems written': 'Стеми збережено',
  'loading beatnet': 'Завантажую BeatNet',
  'detecting tempo': 'Визначаю BPM',
  done: 'Готово',
};

export function JobRow({ job, onCancel }: JobRowProps) {
  const percent = Math.round(job.progress * 100);
  const label = PHASE_LABELS[job.phase] ?? job.phase;
  return (
    <div
      data-testid={`job-${job.id}`}
      className="rounded-md border border-white/10 p-3"
    >
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="t-primary text-body truncate">{filename(job.input_path)}</div>
          <div className="text-meta opacity-60">{label}</div>
        </div>
        <span className="t-tertiary text-meta font-mono">{percent}%</span>
        <Button
          size="sm"
          variant="ghost"
          tone="danger"
          shape="square"
          aria-label="Скасувати"
          title="Скасувати"
          onClick={() => onCancel(job.id)}
        >
          ×
        </Button>
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
