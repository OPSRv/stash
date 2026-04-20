import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { IconButton } from '../../shared/ui/IconButton';
import { Kbd } from '../../shared/ui/Kbd';
import { NextIcon, PauseIcon, PlayIcon, StopCircleIcon } from '../../shared/ui/icons';
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

/// Posture-tinted accent used for the pane tint + progress color so the
/// active block gives the player a different energy (sit = calm, walk =
/// warm). Values match the muted tones in PostureBadge.
const POSTURE_TINT: Record<Posture, { bg: string; ring: string }> = {
  sit:  { bg: 'rgba(120, 130, 160, 0.10)', ring: 'rgba(120, 130, 160, 0.30)' },
  stand:{ bg: 'rgba(110, 170, 130, 0.12)', ring: 'rgba(110, 170, 130, 0.32)' },
  walk: { bg: 'rgba(200, 150, 90, 0.12)',  ring: 'rgba(200, 150, 90, 0.32)' },
};

export const SessionPlayer = ({ snapshot, banner, onDismissBanner }: SessionPlayerProps) => {
  const [stopConfirm, setStopConfirm] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);

  const { blocks, current_idx, remaining_ms, status } = snapshot;
  const current = blocks[current_idx];
  const isRunning = status === 'running';
  const isPaused = status === 'paused';

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

  const upNext = useMemo(() => blocks.slice(current_idx + 1), [blocks, current_idx]);

  // Global keyboard shortcuts while a session is active (Space to pause/resume,
  // ⌘→ for skip, ⌘. to stop). Skips when user is typing in an input/textarea.
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
      } else if (e.metaKey && e.key === 'ArrowRight') {
        e.preventDefault();
        skipTo(current_idx + 1).catch(() => {});
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isRunning, isPaused, current_idx]);

  if (!current) {
    return <div className="p-6 t-tertiary">No active block.</div>;
  }

  const tint = POSTURE_TINT[current.posture];

  return (
    <div className="flex flex-col h-full relative">
      {banner && (
        <div
          role="status"
          className="px-4 py-2.5 flex items-center justify-between border-b hair"
          style={{ background: 'rgba(var(--stash-accent-rgb),0.14)' }}
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

      <div className="flex-1 flex flex-col items-center justify-center px-8 pt-4 pb-6">
        {/* Posture-tinted clock card */}
        <div
          className="relative rounded-2xl px-10 py-8 flex flex-col items-center gap-4 w-full max-w-md"
          style={{
            background: tint.bg,
            boxShadow: `inset 0 0 0 0.5px ${tint.ring}`,
          }}
        >
          <div className="flex items-center justify-between w-full">
            <span className="section-label">
              Block {current_idx + 1} / {blocks.length}
            </span>
            <PostureBadge posture={current.posture} size="md" />
          </div>

          <div
            className="t-primary font-mono tabular-nums text-center w-full"
            style={{
              fontSize: 92,
              lineHeight: 1,
              letterSpacing: '-0.02em',
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
                className="flex-1 text-left t-primary text-title font-medium hover:underline truncate"
                title="Click to rename this block"
              >
                {current.name}
              </button>
            )}
            {isPaused && (
              <span className="t-tertiary text-meta uppercase tracking-wide">
                paused
              </span>
            )}
          </div>

          {/* Progress */}
          <div
            className="relative w-full h-2 rounded-full overflow-hidden"
            style={{ background: 'rgba(255,255,255,0.08)' }}
            role="progressbar"
            aria-valuenow={Math.round(progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={`h-full rounded-full ${
                isRunning ? 'prog-fill' : isPaused ? 'prog-fill-paused' : ''
              }`}
              style={{
                width: `${progress * 100}%`,
                transition: 'width 180ms linear',
              }}
            />
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2 mt-5">
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
            title="Skip to next block (⌘→)"
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

      {upNext.length > 0 && (
        <div className="border-t hair px-4 py-3">
          <div className="section-label mb-2">Up next</div>
          <div className="flex items-center gap-2 overflow-x-auto">
            {upNext.map((b, i) => (
              <div
                key={b.id}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border hair shrink-0"
                style={{ background: 'rgba(255,255,255,0.02)' }}
              >
                <PostureBadge posture={b.posture} />
                <span className="t-primary text-meta truncate max-w-[14ch]">
                  {b.name}
                </span>
                <span className="t-tertiary text-[11px] font-mono tabular-nums">
                  {Math.round(b.duration_sec / 60)}m
                </span>
                <IconButton
                  onClick={() => skipTo(current_idx + 1 + i)}
                  title="Skip to this block"
                >
                  <NextIcon size={11} />
                </IconButton>
              </div>
            ))}
          </div>
        </div>
      )}

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
