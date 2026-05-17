import { CompletedDownloadTile } from './CompletedDownloadTile';
import type { DownloadJob } from './api';

interface CompletedGridProps {
  jobs: DownloadJob[];
  onPlay: (path: string | null) => void;
  onDelete: (id: number, purgeFile: boolean) => void;
  onRetry?: (id: number) => void;
  /// Save the video's subtitle track to a new note. yt-dlp serialises
  /// extraction per-process so the parent disables every tile's chip
  /// while one of them is running.
  onExtractSubtitles?: (job: DownloadJob) => void;
  /// Id of the tile currently running a subtitle extraction, or null.
  /// Drives both the per-tile tooltip ("Extracting subtitles…" vs
  /// "Another subtitle extraction is running") and the global disabled
  /// state on every chip.
  extractingId?: number | null;
}

export const CompletedGrid = ({
  jobs,
  onPlay,
  onDelete,
  onRetry,
  onExtractSubtitles,
  extractingId,
}: CompletedGridProps) => {
  const busy = extractingId != null;
  return (
    <div className="mx-3 grid grid-cols-4 gap-2">
      {jobs.map((job) => {
        const isMe = extractingId === job.id;
        return (
          <CompletedDownloadTile
            key={job.id}
            job={job}
            onPlay={onPlay}
            onDelete={onDelete}
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
