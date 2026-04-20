import { CompletedDownloadRow } from './CompletedDownloadRow';
import type { DownloadJob } from './api';

interface CompletedListProps {
  jobs: DownloadJob[];
  onPlay: (path: string | null) => void;
  onDelete: (id: number, purgeFile: boolean) => void;
  onRetry: (id: number) => void;
  onExtractSubtitles?: (job: DownloadJob) => void;
  extractingId?: number | null;
}

const borderStyle = { border: '1px solid rgba(255,255,255,0.05)' } as const;

export const CompletedList = ({
  jobs,
  onPlay,
  onDelete,
  onRetry,
  onExtractSubtitles,
  extractingId,
}: CompletedListProps) => (
  <div className="mx-3 rounded-xl overflow-hidden" style={borderStyle}>
    {jobs.map((job, i) => (
      <CompletedDownloadRow
        key={job.id}
        job={job}
        zebra={i % 2 === 0}
        onDelete={onDelete}
        onPlay={onPlay}
        onRetry={onRetry}
        onExtractSubtitles={onExtractSubtitles}
        extractingSubtitles={extractingId === job.id}
      />
    ))}
  </div>
);
