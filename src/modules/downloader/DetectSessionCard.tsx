import { useEffect, useState } from 'react';

import { IconButton } from '../../shared/ui/IconButton';
import { Spinner } from '../../shared/ui/Spinner';
import { CloseIcon } from '../../shared/ui/icons';
import { DetectSkeletonCard } from './DetectSkeletonCard';
import { DetectedPreviewCard } from './DetectedPreviewCard';
import { QualityPicker } from './QualityPicker';
import type { DetectSession } from './useVideoDetect';
import type { QualityOption } from './api';
import { DEFAULT_QUALITY_OPTIONS, DETECT_SLOW_HINT_THRESHOLD_SEC } from './downloads.constants';

const formatDuration = (sec: number | null): string => {
  if (!sec || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

interface Props {
  session: DetectSession;
  /** Dismiss (cancel + remove card). */
  onDismiss: () => void;
  /** Pure cancel — keeps the card around with error='Cancelled' so the user
   *  can retry or close it explicitly. Currently we opt for dismiss-only UX,
   *  but keeping the prop makes the card reusable for future "retry" flows. */
  onCancel: () => void;
  /** Start the download on the chosen quality. The shell hooks this into
   *  the backend and then removes the session from the queue. */
  onDownload: (args: {
    session: DetectSession;
    chosen: QualityOption;
  }) => Promise<void> | void;
}

/** Wraps the detect-skeleton → preview → error lifecycle of a single paste.
 *  Each card owns its own chosen quality so a shell with three queued
 *  detects doesn't leak the picker state between cards. */
export const DetectSessionCard = ({ session, onDismiss, onCancel: _onCancel, onDownload }: Props) => {
  const { detecting, elapsedSec, quick, detected, error } = session;
  const [pickedFormat, setPickedFormat] = useState<QualityOption | null>(null);

  // Once the full detect resolves, seed or refine the user's chosen quality.
  // If they already picked one of the placeholder options (auto-1080 etc.)
  // and the real option with matching height+kind is now available, swap in
  // the richer format_id — the downloader prefers explicit ids when it has
  // them.
  useEffect(() => {
    if (!detected) return;
    setPickedFormat((prev) => {
      if (!prev) {
        return (
          detected.qualities.find((q) => q.kind === 'video' && q.height === 1080) ??
          detected.qualities[0] ??
          null
        );
      }
      const matched = detected.qualities.find(
        (q) => q.kind === prev.kind && q.height === prev.height
      );
      return matched ?? prev;
    });
  }, [detected]);

  const qualityOptions: QualityOption[] =
    detected?.qualities && detected.qualities.length > 0
      ? detected.qualities
      : (DEFAULT_QUALITY_OPTIONS as unknown as QualityOption[]);

  const startDownload = async () => {
    const chosen = pickedFormat ?? qualityOptions[0] ?? null;
    if (!chosen) return;
    await onDownload({ session, chosen });
  };

  if (error && !detected && !quick) {
    return (
      <div className="mx-4 mt-3">
        <div className="flex items-start gap-2 text-meta px-3 py-2 rounded-md bg-red-500/[0.08] border border-red-500/[0.22] text-red-200/90">
          <div className="flex-1 min-w-0">
            <div className="truncate" title={session.url}>
              {session.url}
            </div>
            {/* yt-dlp errors are often multi-line and far longer than the
                card's width — wrap with `break-words` and cap height so the
                row can't push the rest of the shell off-screen. */}
            <div className="mt-1 break-words whitespace-pre-wrap max-h-24 overflow-y-auto nice-scroll t-tertiary">
              {error}
            </div>
          </div>
          <IconButton
            onClick={onDismiss}
            title="Dismiss"
            tone="danger"
            stopPropagation={false}
          >
            <CloseIcon size={12} />
          </IconButton>
        </div>
      </div>
    );
  }

  if (detecting && !detected && !quick) {
    return <DetectSkeletonCard elapsedSec={elapsedSec} onDismiss={onDismiss} />;
  }

  if (!detected && !quick) return null;

  return (
    <>
      {detecting && elapsedSec > DETECT_SLOW_HINT_THRESHOLD_SEC && (
        <div className="mx-4 mt-2 mb-0 t-tertiary text-meta rounded-md px-3 py-1.5 [background:var(--bg-hover)]">
          YouTube and a few other sites can take 20–40 seconds on the first
          fetch; subsequent detects of the same URL are instant.
        </div>
      )}
      <DetectedPreviewCard
        platform={detected?.platform ?? quick!.platform}
        title={detected?.info.title ?? quick!.preview.title}
        uploader={detected?.info.uploader ?? quick!.preview.uploader}
        thumbnail={detected?.info.thumbnail ?? quick!.preview.thumbnail}
        overlayBadge={
          detected?.info.duration ? (
            <div className="absolute bottom-1 right-1 text-[10px] font-mono text-white/90 px-1 rounded bg-black/60">
              {formatDuration(detected.info.duration)}
            </div>
          ) : undefined
        }
        footerText={
          detected ? (
            `${detected.qualities.length} quality options`
          ) : (
            <span className="flex items-center gap-1.5" role="status">
              <Spinner size={12} /> Fetching exact sizes — pick a quality and
              download now
            </span>
          )
        }
        trailing={
          <>
            <QualityPicker
              options={qualityOptions}
              selected={pickedFormat ?? qualityOptions[0] ?? null}
              onSelect={setPickedFormat}
              onDownload={startDownload}
            />
            <IconButton
              onClick={onDismiss}
              title="Dismiss"
              tone="danger"
              stopPropagation={false}
            >
              <CloseIcon size={12} />
            </IconButton>
          </>
        }
      />
    </>
  );
};
