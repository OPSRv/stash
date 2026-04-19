import { CompletedDownloadRow } from './CompletedDownloadRow';
import type { DownloadJob } from './api';

interface CompletedListProps {
  jobs: DownloadJob[];
  onPlay: (path: string | null) => () => void;
  onDelete: (id: number) => () => void;
  onRetry: (id: number) => () => void;
}

const borderStyle = { border: '1px solid rgba(255,255,255,0.05)' } as const;

export const CompletedList = ({ jobs, onPlay, onDelete, onRetry }: CompletedListProps) => (
  <div className="mx-3 rounded-xl overflow-hidden" style={borderStyle}>
    {jobs.map((job, i) => (
      <CompletedDownloadRow
        key={job.id}
        job={job}
        zebra={i % 2 === 0}
        onDelete={onDelete(job.id)}
        onPlay={onPlay(job.target_path)}
        onRetry={onRetry(job.id)}
      />
    ))}
  </div>
);
