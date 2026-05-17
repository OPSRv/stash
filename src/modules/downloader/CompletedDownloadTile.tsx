import { memo, useCallback, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  CloseIcon,
  CopyIcon,
  ExternalIcon,
  LinkIcon,
  NoteIcon,
  PlayIcon,
  ReuseIcon,
  SplitViewIcon,
  TrashIcon,
  WaveformIcon,
} from '../../shared/ui/icons';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { ContextMenu, type ContextMenuItem } from '../../shared/ui/ContextMenu';
import { Spinner } from '../../shared/ui/Spinner';
import { Tooltip } from '../../shared/ui/Tooltip';
import { TranscriptArea } from '../../shared/ui/TranscriptArea';
import { useTranscription, type TranscriptionHandlers } from '../../shared/hooks/useTranscription';
import { useToast } from '../../shared/ui/Toast';
import { extOf } from '../../shared/util/fileKind';
import { copyText } from '../../shared/util/clipboard';
import { revealFile } from '../../shared/util/revealFile';
import { isSupportedAudio } from '../separator/api';
import { PlatformBadge } from './PlatformBadge';
import { list, setTranscription, transcribeJob } from './api';
import type { DownloadJob } from './api';

// Audio-only formats. Used to gate the Stems hand-off and to flip the
// tile's primary click from `Play in popup` to `Reveal in Finder` —
// Stash already has dedicated audio surfaces (Stems mixer, Notes audio
// embed, Clipboard player), so an in-popup audio player adds nothing
// and steals a click from the more useful "open the folder" action.
const AUDIO_EXTS = new Set(['mp3', 'm4a', 'wav', 'ogg', 'opus', 'flac', 'aac', 'aiff', 'aif']);
// Video containers we ship from yt-dlp. Whisper can decode any of these
// (symphonia reads the audio track; the macOS afconvert / ffmpeg
// fallback handles whatever symphonia rejects).
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv']);

const isAudioExt = (path: string | null) =>
  Boolean(path) && AUDIO_EXTS.has(extOf(path!));
const isVideoExt = (path: string | null) =>
  Boolean(path) && VIDEO_EXTS.has(extOf(path!));

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

/// Anything the Whisper pipeline can transcribe — audio formats decode
/// directly via symphonia; video containers get their audio track
/// demuxed by symphonia or the macOS afconvert / ffmpeg fallback.
const TRANSCRIBABLE_EXTS = new Set([
  ...AUDIO_EXTS,
  ...VIDEO_EXTS,
]);

export const isAudioJob = (job: DownloadJob): boolean => {
  if (job.target_path) {
    return TRANSCRIBABLE_EXTS.has(extOf(job.target_path));
  }
  return false;
};

interface CompletedDownloadTileProps {
  job: DownloadJob;
  /// Triggered only for video downloads. Audio tiles deliberately
  /// route clicks to `Reveal in Finder` instead — Stash has more
  /// useful audio surfaces (Stems, Notes, Clipboard) than an in-popup
  /// player tab.
  onPlay: (path: string | null) => void;
  /// `purgeFile=true` means the user also asked to delete the file from disk.
  /// The tile shows a confirm dialog with an opt-in checkbox, mirroring the
  /// list row so both views can fully remove a download. Callbacks receive
  /// the job's id/path so parents can pass stable references.
  onDelete: (id: number, purgeFile: boolean) => void;
  /// Retry a failed/cancelled download. Grid view renders a retry button on
  /// failed tiles so the user doesn't have to flip to list view to recover.
  onRetry?: (id: number) => void;
  /// Save the video's subtitle track to a new note. yt-dlp serialises
  /// extraction per-process so the parent disables every tile's chip
  /// while one of them is running. Optional — when the parent doesn't
  /// wire it, the chip is hidden.
  onExtractSubtitles?: (job: DownloadJob) => void;
  /// True while *any* tile's subtitle extraction is in flight. Disables
  /// the chip across the grid so users can't queue two yt-dlp spawns.
  extractingSubtitles?: boolean;
  /// Tooltip override for the disabled state — explains whether *this*
  /// tile is the busy one or another tile is blocking it.
  extractingSubtitlesReason?: string;
}

const isFailure = (status: DownloadJob['status']) =>
  status === 'failed' || status === 'cancelled';

const CompletedDownloadTileImpl = ({
  job,
  onPlay,
  onDelete,
  onRetry,
  onExtractSubtitles,
  extractingSubtitles = false,
  extractingSubtitlesReason,
}: CompletedDownloadTileProps) => {
  const failed = isFailure(job.status);
  const { toast } = useToast();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const canPurge = Boolean(job.target_path) && !failed;
  const showTranscript = job.status === 'completed' && isAudioJob(job);
  // Stems hand-off only applies to audio formats Demucs can read.
  const canStems =
    !failed &&
    Boolean(job.target_path) &&
    isSupportedAudio(job.target_path ?? '');
  const isVideo = isVideoExt(job.target_path);
  const isAudio = isAudioExt(job.target_path);
  const canSubtitles = !failed && isVideo && onExtractSubtitles != null;

  const sendToStems = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!job.target_path) return;
    window.dispatchEvent(
      new CustomEvent('stash:navigate', {
        detail: { tabId: 'separator', file: job.target_path },
      }),
    );
  };

  const reveal = useCallback(async () => {
    if (!job.target_path) return;
    try {
      await revealFile(job.target_path);
    } catch (e) {
      toast({ title: 'Could not reveal file', description: String(e), variant: 'error' });
    }
  }, [job.target_path, toast]);

  const openExternally = useCallback(async () => {
    if (!job.target_path) return;
    try {
      const { openPath } = await import('@tauri-apps/plugin-opener');
      await openPath(job.target_path);
    } catch (e) {
      toast({ title: 'Could not open file', description: String(e), variant: 'error' });
    }
  }, [job.target_path, toast]);

  const openSourceUrl = useCallback(async () => {
    if (!job.url) return;
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(job.url);
    } catch (e) {
      toast({ title: 'Could not open URL', description: String(e), variant: 'error' });
    }
  }, [job.url, toast]);

  const copyPath = useCallback(async () => {
    if (!job.target_path) return;
    const ok = await copyText(job.target_path);
    toast({
      title: ok ? 'File path copied' : 'Copy failed',
      variant: ok ? 'success' : 'error',
      durationMs: 1600,
    });
  }, [job.target_path, toast]);

  const copySourceUrl = useCallback(async () => {
    if (!job.url) return;
    const ok = await copyText(job.url);
    toast({
      title: ok ? 'Source URL copied' : 'Copy failed',
      variant: ok ? 'success' : 'error',
      durationMs: 1600,
    });
  }, [job.url, toast]);

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

  const openDelete = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setDeleteOpen(true);
  };

  // Audio tiles route their primary click to Reveal in Finder — Stash
  // already has dedicated audio surfaces and an in-popup player adds
  // no value here. Video tiles keep the original behaviour.
  const onTileClick = () => {
    if (failed) return;
    if (isAudio) {
      void reveal();
      return;
    }
    onPlay(job.target_path);
  };

  // ── right-click context menu ────────────────────────────────────────
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const onContextMenu = (e: React.MouseEvent) => {
    if (!job.target_path && !job.url) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  };
  const menuItems: ContextMenuItem[] = (() => {
    const items: ContextMenuItem[] = [];
    if (isVideo && !failed && job.target_path) {
      items.push({
        kind: 'action',
        label: 'Play in popup',
        icon: <PlayIcon size={12} />,
        onSelect: () => onPlay(job.target_path),
      });
    }
    if (job.target_path && !failed) {
      items.push({
        kind: 'action',
        label: 'Open in default app',
        icon: <ExternalIcon size={12} />,
        onSelect: () => void openExternally(),
      });
      items.push({
        kind: 'action',
        label: 'Reveal in Finder',
        icon: <ExternalIcon size={12} />,
        onSelect: () => void reveal(),
      });
    }
    if (showTranscript && !failed) {
      const running = transcribeStatus === 'running';
      items.push({
        kind: 'action',
        label: running
          ? 'Transcribing…'
          : transcript
            ? 'Re-transcribe'
            : 'Transcribe',
        icon: <WaveformIcon size={12} />,
        disabled: running,
        onSelect: () => transcribe(),
      });
    }
    if (canStems) {
      items.push({
        kind: 'action',
        label: 'Send to Stems',
        icon: <SplitViewIcon size={12} />,
        onSelect: () => {
          if (job.target_path) {
            window.dispatchEvent(
              new CustomEvent('stash:navigate', {
                detail: { tabId: 'separator', file: job.target_path },
              }),
            );
          }
        },
      });
    }
    if (canSubtitles) {
      items.push({
        kind: 'action',
        label: extractingSubtitles ? 'Subtitles busy…' : 'Save subtitles to Notes',
        icon: <NoteIcon size={12} />,
        disabled: extractingSubtitles,
        onSelect: () => onExtractSubtitles!(job),
      });
    }
    if (failed && onRetry) {
      items.push({
        kind: 'action',
        label: 'Retry download',
        icon: <ReuseIcon size={12} />,
        onSelect: () => onRetry(job.id),
      });
    }
    if (items.length > 0) items.push({ kind: 'separator' });
    if (job.url) {
      items.push({
        kind: 'action',
        label: 'Open source URL',
        icon: <LinkIcon size={12} />,
        onSelect: () => void openSourceUrl(),
      });
      items.push({
        kind: 'action',
        label: 'Copy source URL',
        icon: <CopyIcon size={12} />,
        onSelect: () => void copySourceUrl(),
      });
    }
    if (job.target_path) {
      items.push({
        kind: 'action',
        label: 'Copy file path',
        icon: <CopyIcon size={12} />,
        onSelect: () => void copyPath(),
      });
    }
    items.push({ kind: 'separator' });
    items.push({
      kind: 'action',
      label: 'Delete…',
      icon: <TrashIcon size={12} />,
      tone: 'danger',
      onSelect: () => openDelete(),
    });
    return items;
  })();

  // Inline transcript drawer is collapsed by default — keeps the tile
  // visually compact when a transcript exists. Toggled by the chip in
  // the action row.
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const transcribing = transcribeStatus === 'running';
  const hasTranscript = transcript != null && transcript.length > 0;
  const titleText = job.title ?? (job.target_path?.split('/').pop() ?? job.url);

  // Click hint shown over the thumbnail. Audio gets the folder-reveal
  // glyph (ExternalIcon — the same affordance used for "show in
  // Finder" everywhere else in the app); video keeps the play icon.
  const hoverIcon = isAudio ? <ExternalIcon size={20} className="text-white" /> : <PlayIcon size={22} className="text-white translate-x-[1px]" />;
  const hoverHint = isAudio ? 'Reveal in Finder' : 'Play';

  return (
    <div
      className={`group relative rounded-lg overflow-hidden [background:var(--bg-hover)] border [border-color:var(--hairline)] transition-shadow hover:shadow-lg hover:shadow-black/30 ${failed ? 'cursor-default' : 'cursor-pointer'}`}
      onClick={onTileClick}
      onContextMenu={onContextMenu}
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
          <Tooltip label={hoverHint}>
            <div
              className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20"
              aria-hidden
            >
              <div className="w-12 h-12 rounded-full bg-black/55 backdrop-blur-sm flex items-center justify-center ring-1 ring-white/20">
                {hoverIcon}
              </div>
            </div>
          </Tooltip>
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

        {!failed && job.target_path && (
          <div
            className="flex flex-wrap items-center gap-1.5"
            onClick={(e) => e.stopPropagation()}
          >
            <ChipButton
              onClick={() => void reveal()}
              label="Reveal"
              title="Show in Finder"
              icon={<ExternalIcon size={11} />}
            />
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
            {canSubtitles && (
              <Tooltip
                label={
                  extractingSubtitles
                    ? extractingSubtitlesReason ?? 'Another subtitle extraction is running'
                    : 'Save subtitles to Notes'
                }
              >
                <button
                  type="button"
                  onClick={() => onExtractSubtitles!(job)}
                  disabled={extractingSubtitles}
                  aria-label="Save subtitles to Notes"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-meta border [border-color:var(--hairline)] transition-colors t-secondary [background:rgba(255,255,255,0.025)] hover:t-primary hover:[background:rgba(255,255,255,0.06)] disabled:opacity-50"
                >
                  <NoteIcon size={11} />
                  <span>CC</span>
                </button>
              </Tooltip>
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
      {menu && (
        <ContextMenu
          open
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={closeMenu}
          label="Download actions"
        />
      )}
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
  a.onRetry === b.onRetry &&
  a.onExtractSubtitles === b.onExtractSubtitles &&
  a.extractingSubtitles === b.extractingSubtitles &&
  a.extractingSubtitlesReason === b.extractingSubtitlesReason,
);
