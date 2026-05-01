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

export const CompletedList = ({
  jobs,
  onPlay,
  onDelete,
  onRetry,
  onExtractSubtitles,
  extractingId,
}: CompletedListProps) => {
  // yt-dlp serialises subtitle extraction per-process; while one row is
  // running, clicking any other CC button silently drops through in the
  // shell. Rather than leaving those buttons falsely clickable, disable
  // every row's CC while any one of them is busy, with a tooltip that
  // explains *why* instead of making users wonder.
  const busy = extractingId != null;
  return (
    <div className="mx-3 rounded-xl border [border-color:var(--hairline)]">
      {jobs.map((job, i) => {
        const isMe = extractingId === job.id;
        return (
          <CompletedDownloadRow
            key={job.id}
            job={job}
            zebra={i % 2 === 0}
            onDelete={onDelete}
            onPlay={onPlay}
            onRetry={onRetry}
            onExtractSubtitles={onExtractSubtitles}
            extractingSubtitles={busy}
            extractingSubtitlesReason={
              isMe
                ? 'Extracting subtitles…'
                : busy
                  ? 'Another subtitle extraction is running'
                  : undefined
            }
          />
        );
      })}
    </div>
  );
};
