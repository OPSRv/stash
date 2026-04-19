import { CompletedDownloadTile } from './CompletedDownloadTile';
import type { DownloadJob } from './api';

interface CompletedGridProps {
  jobs: DownloadJob[];
  onPlay: (path: string | null) => () => void;
  onDelete: (id: number) => () => void;
}

export const CompletedGrid = ({ jobs, onPlay, onDelete }: CompletedGridProps) => (
  <div className="mx-3 grid grid-cols-4 gap-2">
    {jobs.map((job) => (
      <CompletedDownloadTile
        key={job.id}
        job={job}
        onPlay={onPlay(job.target_path)}
        onDelete={onDelete(job.id)}
      />
    ))}
  </div>
);
