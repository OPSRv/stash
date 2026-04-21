import { CompletedDownloadTile } from './CompletedDownloadTile';
import type { DownloadJob } from './api';

interface CompletedGridProps {
  jobs: DownloadJob[];
  onPlay: (path: string | null) => void;
  onDelete: (id: number, purgeFile: boolean) => void;
  onRetry?: (id: number) => void;
}

export const CompletedGrid = ({ jobs, onPlay, onDelete, onRetry }: CompletedGridProps) => (
  <div className="mx-3 grid grid-cols-4 gap-2">
    {jobs.map((job) => (
      <CompletedDownloadTile
        key={job.id}
        job={job}
        onPlay={onPlay}
        onDelete={onDelete}
        onRetry={onRetry}
      />
    ))}
  </div>
);
