import { useCallback, useEffect, useMemo, useState } from 'react';
import { accent } from '../../shared/theme/accent';
import { Button } from '../../shared/ui/Button';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { IconButton } from '../../shared/ui/IconButton';
import { Kbd } from '../../shared/ui/Kbd';
import {
  CheckIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  StopCircleIcon,
} from '../../shared/ui/icons';
import {
  editBlocks,
  pauseSession,
  resumeSession,
  skipTo,
  stopSession,
  type Block,
  type Posture,
  type SessionSnapshot,
} from './api';
import { formatMmSs, transitionText } from './constants';
import { PostureBadge } from './PostureBadge';

interface SessionPlayerProps {
  snapshot: SessionSnapshot;
  banner: { from: Posture; to: Posture; block: string } | null;
  onDismissBanner: () => void;
}

const renameInTrack = (blocks: Block[], idx: number, name: string): Block[] =>
  blocks.map((b, i) => (i === idx ? { ...b, name } : b));

const POSTURE_EMOJI: Record<Posture, string> = {
  sit: '💺',
  stand: '🧍',
  walk: '🚶',
};

export const SessionPlayer = ({ snapshot, banner, onDismissBanner }: SessionPlayerProps) => {
  const [stopConfirm, setStopConfirm] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);

  const { blocks, current_idx, remaining_ms, status } = snapshot;
  const current = blocks[current_idx];
  const isRunning = status === 'running';
  const isPaused = status === 'paused';
  const canGoBack = current_idx > 0;
  const canGoForward = current_idx < blocks.length - 1;

  const totalMs = current ? current.duration_sec * 1000 : 0;
  const progress = totalMs > 0 ? Math.max(0, Math.min(1, 1 - remaining_ms / totalMs)) : 0;

  const commitName = useCallback(async () => {
    if (editingName === null || !current) return;
    const trimmed = editingName.trim();
    setEditingName(null);
    if (trimmed === '' || trimmed === current.name) return;
    try {
      await editBlocks(renameInTrack(blocks, current_idx, trimmed));
    } catch (e) {
      console.error('rename failed', e);
    }
  }, [editingName, current, blocks, current_idx]);

  // Keyboard shortcuts while active. Space = pause/resume, ⌘← / ⌘→ move
  // between blocks (both directions — backward restarts that block from
  // full duration, which is what the engine.skip_to already does).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      const typing =
        tgt?.tagName === 'INPUT' ||
        tgt?.tagName === 'TEXTAREA' ||
        tgt?.isContentEditable === true;
      if (typing) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (isRunning) pauseSession().catch(() => {});
        else if (isPaused) resumeSession().catch(() => {});
      } else if (e.metaKey && e.key === 'ArrowRight' && canGoForward) {
        e.preventDefault();
        skipTo(current_idx + 1).catch(() => {});
      } else if (e.metaKey && e.key === 'ArrowLeft' && canGoBack) {
        e.preventDefault();
        skipTo(current_idx - 1).catch(() => {});
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isRunning, isPaused, current_idx, canGoBack, canGoForward]);

  const totalSec = useMemo(
    () => blocks.reduce((s, b) => s + b.duration_sec, 0),
    [blocks],
  );
  const elapsedSec = useMemo(() => {
    const past = blocks
      .slice(0, current_idx)
      .reduce((s, b) => s + b.duration_sec, 0);
    const currentElapsed = current
      ? current.duration_sec - Math.floor(remaining_ms / 1000)
      : 0;
    return past + Math.max(0, currentElapsed);
  }, [blocks, current_idx, current, remaining_ms]);
  const sessionProgress = totalSec > 0 ? elapsedSec / totalSec : 0;

  if (!current) {
    return <div className="p-6 t-tertiary">No active block.</div>;
  }

  return (
    <div className="flex flex-col h-full relative">
      {banner && (
        <div
          role="status"
          className="px-4 py-2.5 flex items-center justify-between border-b hair"
          style={{ background: accent(0.14) }}
        >
          <div className="flex items-center gap-2">
            <PostureBadge posture={banner.to} size="md" />
            <span className="t-primary text-body font-medium">
              {transitionText(banner.from, banner.to)}
            </span>
            <span className="t-tertiary text-meta">→ {banner.block}</span>
          </div>
          <Button size="xs" variant="ghost" onClick={onDismissBanner}>
            Got it
          </Button>
        </div>
      )}

      {/* Session-wide progress (thin bar across the whole header) */}
      <div
        className="h-[3px] relative overflow-hidden"
        style={{ background: 'rgba(255,255,255,0.05)' }}
        role="progressbar"
        aria-valuenow={Math.round(sessionProgress * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Session progress"
      >
        <div
          className={isRunning ? 'prog-fill' : 'prog-fill-paused'}
          style={{
            width: `${sessionProgress * 100}%`,
            height: '100%',
            transition: 'width 220ms linear',
          }}
        />
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-8 pt-6 pb-6">
        <div className="flex items-center justify-between w-full max-w-md mb-3">
          <span className="section-label">
            Block {current_idx + 1} / {blocks.length}
          </span>
          <PostureBadge posture={current.posture} size="md" />
        </div>

        {/* Clock with aura glow */}
        <div
          className={`relative rounded-[20px] px-10 py-8 w-full max-w-md flex flex-col items-center gap-5 ${
            isRunning ? 'pomo-aura-running' : 'pomo-aura-paused'
          }`}
          style={{
            background:
              'linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.015) 100%)',
          }}
        >
          <div
            className={`pomo-clock-digits font-mono tabular-nums text-center ${
              isPaused ? 'pomo-clock-paused' : ''
            }`}
            style={{
              fontSize: 96,
              lineHeight: 1,
              letterSpacing: '-0.03em',
              fontWeight: 500,
            }}
            aria-live="polite"
            aria-label={`${formatMmSs(remaining_ms)} remaining`}
          >
            {formatMmSs(remaining_ms)}
          </div>

          <div className="w-full flex items-center gap-2">
            {editingName !== null ? (
              <input
                autoFocus
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitName();
                  else if (e.key === 'Escape') setEditingName(null);
                }}
                className="flex-1 bg-transparent border-b border-[var(--color-border)] t-primary text-title font-medium outline-none px-1"
                aria-label="Rename current block"
              />
            ) : (
              <button
                type="button"
                onClick={() => setEditingName(current.name)}
                className="flex-1 text-center t-primary text-title font-medium hover:underline truncate"
                title="Click to rename this block"
              >
                {current.name}
              </button>
            )}
            {isPaused && (
              <span className="t-tertiary text-meta uppercase tracking-wide shrink-0">
                paused
              </span>
            )}
          </div>

          {/* Block-local progress */}
          <div
            className="relative w-full h-1.5 rounded-full overflow-hidden"
            style={{ background: 'rgba(255,255,255,0.07)' }}
            role="progressbar"
            aria-valuenow={Math.round(progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${current.name} progress`}
          >
            <div
              className={`h-full rounded-full ${
                isRunning ? 'prog-fill' : 'prog-fill-paused'
              }`}
              style={{
                width: `${progress * 100}%`,
                transition: 'width 180ms linear',
              }}
            />
          </div>
        </div>

        {/* Transport controls */}
        <div className="flex items-center gap-2 mt-5">
          <IconButton
            onClick={() => skipTo(current_idx - 1)}
            title="Previous block (⌘←)"
            disabled={!canGoBack}
          >
            <PrevIcon size={13} />
          </IconButton>
          {isRunning && (
            <Button
              leadingIcon={<PauseIcon size={13} />}
              onClick={() => pauseSession()}
            >
              Pause
              <span className="ml-2 opacity-60">
                <Kbd>Space</Kbd>
              </span>
            </Button>
          )}
          {isPaused && (
            <Button
              tone="accent"
              leadingIcon={<PlayIcon size={13} />}
              onClick={() => resumeSession()}
            >
              Resume
              <span className="ml-2 opacity-60">
                <Kbd>Space</Kbd>
              </span>
            </Button>
          )}
          <IconButton
            onClick={() => skipTo(current_idx + 1)}
            title="Next block (⌘→)"
            disabled={!canGoForward}
          >
            <NextIcon size={13} />
          </IconButton>
          <IconButton
            onClick={() => setStopConfirm(true)}
            title="Stop session"
            tone="danger"
          >
            <StopCircleIcon size={13} />
          </IconButton>
        </div>
      </div>

      {/* Timeline — every block, jump to any. Past blocks are greyed with a
          check so the user can scroll history and restart an earlier one. */}
      <div className="border-t hair px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <span className="section-label">Timeline</span>
          <span className="t-tertiary text-meta font-mono tabular-nums">
            {Math.round(elapsedSec / 60)}m / {Math.round(totalSec / 60)}m
          </span>
        </div>
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {blocks.map((b, i) => {
            const isCurrent = i === current_idx;
            const isDone = i < current_idx;
            const cls = `pomo-chip shrink-0 ${
              isCurrent
                ? 'pomo-chip-current'
                : isDone
                  ? 'pomo-chip-done'
                  : ''
            }`;
            return (
              <button
                key={b.id}
                type="button"
                onClick={() => skipTo(i)}
                className={cls}
                title={isDone ? 'Restart this block' : isCurrent ? 'Current' : 'Jump to this block'}
                aria-label={`${
                  isDone ? 'Restart' : isCurrent ? 'Current' : 'Jump to'
                } block: ${b.name}`}
                aria-current={isCurrent ? 'true' : undefined}
              >
                <span aria-hidden className="text-body">
                  {POSTURE_EMOJI[b.posture]}
                </span>
                <span className="t-primary text-meta font-medium truncate max-w-[12ch]">
                  {b.name}
                </span>
                <span className="t-tertiary text-meta font-mono tabular-nums">
                  {Math.round(b.duration_sec / 60)}m
                </span>
                {isDone && (
                  <span className="pomo-chip-check inline-flex" aria-hidden>
                    <CheckIcon size={11} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <ConfirmDialog
        open={stopConfirm}
        title="Stop this session?"
        description="Your progress up to now is saved to history."
        confirmLabel="Stop"
        tone="danger"
        onConfirm={() => {
          setStopConfirm(false);
          stopSession().catch((e) => console.error('stop failed', e));
        }}
        onCancel={() => setStopConfirm(false)}
      />
    </div>
  );
};
