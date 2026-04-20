import { useCallback, useMemo, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { IconButton } from '../../shared/ui/IconButton';
import { NextIcon, PauseIcon, PlayIcon, StopCircleIcon } from '../../shared/ui/icons';
import {
  editBlocks,
  pauseSession,
  resumeSession,
  skipTo,
  stopSession,
  type Block,
  type SessionSnapshot,
} from './api';
import { formatMmSs, transitionText } from './constants';
import { PostureBadge } from './PostureBadge';

interface SessionPlayerProps {
  snapshot: SessionSnapshot;
  banner: { from: Block['posture']; to: Block['posture']; block: string } | null;
  onDismissBanner: () => void;
}

const renameInTrack = (blocks: Block[], idx: number, name: string): Block[] =>
  blocks.map((b, i) => (i === idx ? { ...b, name } : b));

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

  if (!current) {
    return <div className="p-6 t-tertiary">No active block.</div>;
  }

  return (
    <div className="flex flex-col h-full">
      {banner && (
        <div
          role="status"
          className="px-3 py-2 flex items-center justify-between border-b hair"
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
      <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 pt-4">
        <div
          className="t-primary font-mono tabular-nums"
          style={{ fontSize: 84, lineHeight: 1 }}
        >
          {formatMmSs(remaining_ms)}
        </div>
        <div className="flex items-center gap-2">
          <PostureBadge posture={current.posture} size="md" />
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
              className="bg-transparent border-b border-[var(--color-border)] t-primary text-body outline-none"
              aria-label="Rename current block"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingName(current.name)}
              className="t-primary text-body font-medium hover:underline"
              title="Click to rename this block"
            >
              {current.name}
            </button>
          )}
        </div>
        <div
          className="w-full max-w-sm h-1.5 rounded-full overflow-hidden"
          style={{ background: 'rgba(255,255,255,0.08)' }}
          role="progressbar"
          aria-valuenow={Math.round(progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full"
            style={{
              width: `${progress * 100}%`,
              background: 'var(--stash-accent)',
              transition: 'width 180ms linear',
            }}
          />
        </div>
        <div className="flex items-center gap-2 mt-2">
          {isRunning && (
            <Button leadingIcon={<PauseIcon size={13} />} onClick={() => pauseSession()}>
              Pause
            </Button>
          )}
          {isPaused && (
            <Button
              tone="accent"
              leadingIcon={<PlayIcon size={13} />}
              onClick={() => resumeSession()}
            >
              Resume
            </Button>
          )}
          <IconButton
            onClick={() => skipTo(current_idx + 1)}
            title="Skip to next block"
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
        <div className="t-tertiary text-meta">
          Block {current_idx + 1} of {blocks.length}
        </div>
      </div>
      {upNext.length > 0 && (
        <div className="border-t hair px-3 py-2 flex items-center gap-2 overflow-x-auto">
          <span className="t-tertiary text-[11px] uppercase tracking-wide shrink-0">
            Up next
          </span>
          {upNext.map((b, i) => (
            <div
              key={b.id}
              className="flex items-center gap-1.5 px-2 py-1 rounded border hair shrink-0"
            >
              <PostureBadge posture={b.posture} />
              <span className="t-primary text-meta truncate max-w-[10ch]">{b.name}</span>
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
