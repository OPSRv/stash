import { memo, useCallback, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { CloseIcon, PlayIcon, ReuseIcon, SplitViewIcon, WaveformIcon } from '../../shared/ui/icons';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { Spinner } from '../../shared/ui/Spinner';
import { Tooltip } from '../../shared/ui/Tooltip';
import { TranscriptArea } from '../../shared/ui/TranscriptArea';
import { useTranscription, type TranscriptionHandlers } from '../../shared/hooks/useTranscription';
import { extOf } from '../../shared/util/fileKind';
import { isSupportedAudio } from '../separator/api';
import { PlatformBadge } from './PlatformBadge';
import { list, setTranscription, transcribeJob } from './api';
import type { DownloadJob } from './api';

const AUDIO_EXTS = new Set(['mp3', 'm4a', 'wav', 'ogg', 'opus', 'flac', 'aac', 'aiff', 'aif']);

interface ChipButtonProps {
  onClick: (e: React.MouseEvent) => void;
  label: string;
  title: string;
  icon: React.ReactNode;
  /** Optional pressed state — used by the transcript toggle to look
   *  like a segmented control rather than a one-shot action. */
  pressed?: boolean;
}

/// Small icon+label chip used in the tile's action row. Replaces the
/// previous full-width `<Button>`s — those competed visually with the
/// thumbnail and made every tile bottom-heavy. Chips wrap to a second
/// line on narrow widths.
const ChipButton = ({ onClick, label, title, icon, pressed }: ChipButtonProps) => (
  <Tooltip label={title}>
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-meta border [border-color:var(--hairline)] transition-colors ${
        pressed
          ? 't-primary [background:var(--bg-active,rgba(255,255,255,0.08))]'
          : 't-secondary [background:rgba(255,255,255,0.025)] hover:t-primary hover:[background:rgba(255,255,255,0.06)]'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  </Tooltip>
);

export const isAudioJob = (job: DownloadJob): boolean => {
  if (job.target_path) {
    return AUDIO_EXTS.has(extOf(job.target_path));
  }
  return false;
};

interface CompletedDownloadTileProps {
  job: DownloadJob;
  onPlay: (path: string | null) => void;
  /// `purgeFile=true` means the user also asked to delete the file from disk.
  /// The tile shows a confirm dialog with an opt-in checkbox, mirroring the
  /// list row so both views can fully remove a download. Callbacks receive
  /// the job's id/path so parents can pass stable references.
  onDelete: (id: number, purgeFile: boolean) => void;
  /// Retry a failed/cancelled download. Grid view renders a retry button on
  /// failed tiles so the user doesn't have to flip to list view to recover.
  onRetry?: (id: number) => void;
}

const isFailure = (status: DownloadJob['status']) =>
  status === 'failed' || status === 'cancelled';

const CompletedDownloadTileImpl = ({
  job,
  onPlay,
  onDelete,
  onRetry,
}: CompletedDownloadTileProps) => {
  const failed = isFailure(job.status);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const canPurge = Boolean(job.target_path) && !failed;
  const showTranscript = job.status === 'completed' && isAudioJob(job);
  // Stems hand-off only applies to audio formats Demucs can read. Mirrors
  // the row-view check in `CompletedDownloadRow` so both surfaces gate
  // the action consistently — and quietly hides for video downloads.
  const canStems =
    !failed &&
    Boolean(job.target_path) &&
    isSupportedAudio(job.target_path ?? '');

  const sendToStems = (e: React.MouseEvent) => {
    // The whole tile is clickable as Play; stop the click before it
    // bubbles up to the parent's onPlay handler.
    e.stopPropagation();
    if (!job.target_path) return;
    window.dispatchEvent(
      new CustomEvent('stash:navigate', {
        detail: { tabId: 'separator', file: job.target_path },
      }),
    );
  };

  // Stable subscribe fn for useTranscription — listens to the three
  // downloader transcription events filtered to this job's id.
  const subscribe = useCallback(
    (handlers: TranscriptionHandlers) => {
      let cancelled = false;
      const unlisteners: Array<() => void> = [];

      Promise.all([
        listen<{ id: number }>('downloader:transcribing', (e) => {
          if (!cancelled && e.payload.id === job.id) handlers.onStart();
        }),
        listen<{ id: number }>('downloader:job_updated', async (e) => {
          if (cancelled || e.payload.id !== job.id) return;
          const jobs = await list();
          const updated = jobs.find((j) => j.id === job.id);
          if (updated?.transcription != null) handlers.onDone(updated.transcription);
        }),
        listen<{ id: number; error: string }>('downloader:transcribe_failed', (e) => {
          if (!cancelled && e.payload.id === job.id) handlers.onFailed(e.payload.error);
        }),
      ]).then((fns) => {
        if (!cancelled) unlisteners.push(...fns);
        else fns.forEach((f) => f());
      });

      return () => {
        cancelled = true;
        unlisteners.forEach((f) => f());
      };
    },
    // job.id is stable for the lifetime of a tile
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [job.id],
  );

  const { transcript, status: transcribeStatus, failed: transcribeFailed, transcribe } =
    useTranscription({
      initial: job.transcription,
      start: () => transcribeJob(job.id),
      subscribe,
    });

  const openDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteOpen(true);
  };

  const onTileClick = () => {
    if (failed) return; // retry is the only meaningful action on a failed tile
    onPlay(job.target_path);
  };

  // Inline transcript drawer is collapsed by default — keeps the tile
  // visually compact when a transcript exists. Toggled by the chip in
  // the action row.
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const transcribing = transcribeStatus === 'running';
  const hasTranscript = transcript != null && transcript.length > 0;
  const hasActions =
    !failed && (showTranscript || canStems);
  const titleText = job.title ?? (job.target_path?.split('/').pop() ?? job.url);

  return (
    <div
      className={`group relative rounded-lg overflow-hidden [background:var(--bg-hover)] border [border-color:var(--hairline)] transition-shadow hover:shadow-lg hover:shadow-black/30 ${failed ? 'cursor-default' : 'cursor-pointer'}`}
      onClick={onTileClick}
    >
      <div
        className="aspect-video relative bg-black/60"
        title={failed ? job.error ?? 'Download failed' : undefined}
      >
        {job.thumbnail_url ? (
          <img
            src={job.thumbnail_url}
            alt=""
            className={`w-full h-full object-cover transition-transform duration-300 ${failed ? 'opacity-40' : 'group-hover:scale-[1.04]'}`}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center t-tertiary text-meta">
            {failed ? 'Failed' : 'No preview'}
          </div>
        )}

        {/* Platform chip — small, top-left, always visible. The title
            now lives below the thumbnail so this is the only overlay. */}
        <div className="absolute top-1.5 left-1.5">
          <PlatformBadge platform={job.platform} />
        </div>

        {!failed && (
          <div
            className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20"
          >
            <div className="w-12 h-12 rounded-full bg-black/55 backdrop-blur-sm flex items-center justify-center ring-1 ring-white/20">
              <PlayIcon size={22} className="text-white translate-x-[1px]" />
            </div>
          </div>
        )}
        {failed && onRetry && (
          <Tooltip label={job.error ? `Retry — ${job.error}` : 'Retry download'}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRetry(job.id);
              }}
              className="absolute inset-0 flex items-center justify-center gap-1.5 text-white opacity-0 group-hover:opacity-100 transition-opacity bg-black/40"
              aria-label="Retry download"
            >
              <ReuseIcon size={16} />
              <span className="text-meta">Retry</span>
            </button>
          </Tooltip>
        )}
        <Tooltip label="Delete">
          <button
            onClick={openDelete}
            className="absolute top-1.5 right-1.5 w-6 h-6 rounded-md items-center justify-center hidden group-hover:flex bg-black/[0.55] backdrop-blur-sm ring-1 ring-white/15"
            aria-label="Delete"
          >
            <CloseIcon className="text-white" size={12} />
          </button>
        </Tooltip>
      </div>

      {/* Info section — title above, compact action chips below. The
          chips replace the old full-width Transcribe/Stems buttons that
          made the card visually bottom-heavy. */}
      <div className="px-2.5 py-2 flex flex-col gap-1.5">
        <div
          className="text-body t-primary font-medium leading-snug line-clamp-2"
          title={titleText}
        >
          {titleText}
        </div>

        {hasActions && (
          <div
            className="flex flex-wrap items-center gap-1.5"
            onClick={(e) => e.stopPropagation()}
          >
            {showTranscript && transcribing && (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-meta t-secondary [background:var(--bg-hover-strong,rgba(255,255,255,0.05))] border [border-color:var(--hairline)]">
                <Spinner size={10} />
                Transcribing…
              </span>
            )}
            {showTranscript && !transcribing && transcribeFailed && !hasTranscript && (
              <Tooltip label="Retry transcription">
                <button
                  onClick={transcribe}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-meta text-amber-300/90 [background:rgba(251,191,36,0.08)] border [border-color:rgba(251,191,36,0.25)] hover:[background:rgba(251,191,36,0.14)] transition-colors"
                >
                  <ReuseIcon size={11} />
                  Transcription failed
                </button>
              </Tooltip>
            )}
            {showTranscript && !transcribing && !transcribeFailed && !hasTranscript && (
              <ChipButton
                onClick={transcribe}
                label="Transcribe"
                title="Transcribe audio with Whisper"
                icon={<WaveformIcon size={11} />}
              />
            )}
            {showTranscript && hasTranscript && (
              <ChipButton
                onClick={() => setTranscriptOpen((v) => !v)}
                label={transcriptOpen ? 'Hide transcript' : 'Transcript'}
                title={transcriptOpen ? 'Collapse transcript' : 'Show transcript'}
                icon={<WaveformIcon size={11} />}
                pressed={transcriptOpen}
              />
            )}
            {canStems && (
              <ChipButton
                onClick={sendToStems}
                label="Stems"
                title="Split into stems (Demucs) and detect BPM"
                icon={<SplitViewIcon size={11} />}
              />
            )}
          </div>
        )}

        {/* Inline transcript drawer — only mounts when expanded so a
            tile with a long transcript doesn't pay layout cost until
            the user opts in. */}
        {showTranscript && hasTranscript && transcriptOpen && (
          <div
            className="pt-1.5 mt-0.5 border-t [border-color:var(--hairline)]"
            onClick={(e) => e.stopPropagation()}
          >
            <TranscriptArea
              transcript={transcript}
              transcribing={false}
              failed={false}
              onEdit={(t) => setTranscription(job.id, t)}
            />
          </div>
        )}
      </div>
      <ConfirmDialog
        open={deleteOpen}
        title="Delete this download?"
        description={
          canPurge
            ? 'Removes the entry from history. Tick the box to also delete the file from disk.'
            : 'Removes the entry from history.'
        }
        confirmLabel="Delete"
        tone="danger"
        suppressibleLabel={canPurge ? 'Also delete the downloaded file' : undefined}
        onConfirm={(alsoPurge) => {
          setDeleteOpen(false);
          onDelete(job.id, Boolean(canPurge && alsoPurge));
        }}
        onCancel={() => setDeleteOpen(false)}
      />
    </div>
  );
};

/// Tiles scroll in a grid that re-renders whenever any job in the list
/// ticks (download progress, transient hover state). Memoising skips tiles
/// whose own job snapshot hasn't changed.
export const CompletedDownloadTile = memo(CompletedDownloadTileImpl, (a, b) =>
  a.job === b.job &&
  a.onPlay === b.onPlay &&
  a.onDelete === b.onDelete &&
  a.onRetry === b.onRetry,
);
