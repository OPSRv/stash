import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ContextMenu, type ContextMenuItem } from '../../shared/ui/ContextMenu';
import { IconButton } from '../../shared/ui/IconButton';
import { Input } from '../../shared/ui/Input';
import type { Block, Posture } from './api';

export type TimelineMode = 'edit' | 'playing';

interface TimelineProps {
  blocks: Block[];
  mode: TimelineMode;
  /** Edit-mode: fired whenever the user reorders/resizes/renames/changes posture. */
  onChange?: (next: Block[]) => void;
  /** Edit-mode: delete block by id. */
  onDelete?: (id: string) => void;
  /** Playing-mode: index of the current block. */
  currentIdx?: number;
  /** Playing-mode: 0..1 progress through the current block. */
  progress?: number;
  /** Playing-mode: jump to a specific block index (click-to-jump). */
  onJumpTo?: (idx: number) => void;
}

const MIN_MIN = 1;
const MAX_MIN = 240;

const POSTURE_ORDER: Posture[] = ['sit', 'stand', 'walk'];
const POSTURE_EMOJI: Record<Posture, string> = {
  sit: '💺',
  stand: '🧍',
  walk: '🚶',
};

type DragState =
  | { kind: 'idle' }
  | {
      kind: 'reorder';
      id: string;
      startX: number;
      originIdx: number;
      targetIdx: number;
      deltaX: number;
      /** Block centers captured at drag-start — measured once so layout shifts
       * during the drag don't corrupt the target-position calculation. */
      centers: number[];
      /** Left/right in viewport coordinates for the drop indicator. */
      rects: { left: number; right: number }[];
      timelineLeft: number;
    }
  | {
      kind: 'resize';
      id: string;
      startX: number;
      startDuration: number;
      pxPerMin: number;
    };

const clampMin = (n: number) => Math.max(MIN_MIN, Math.min(MAX_MIN, n));

export const Timeline = ({
  blocks,
  mode,
  onChange,
  onDelete,
  currentIdx,
  progress,
  onJumpTo,
}: TimelineProps) => {
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const blockRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState>({ kind: 'idle' });
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; block: Block } | null>(null);

  const editable = mode === 'edit';

  const totalMin = blocks.reduce((s, b) => s + b.duration_sec / 60, 0) || 1;

  // --- Reorder via pointer -------------------------------------------------
  const onBlockPointerDown = (
    e: React.PointerEvent<HTMLDivElement>,
    block: Block,
  ) => {
    if (!editable) return;
    if ((e.target as HTMLElement).closest('[data-role="resize"]')) return;
    if ((e.target as HTMLElement).closest('[data-role="no-drag"]')) return;
    const originIdx = blocks.findIndex((b) => b.id === block.id);
    if (originIdx === -1) return;
    const rects = blocks.map((b) => {
      const el = blockRefs.current.get(b.id);
      if (!el) return { left: 0, right: 0 };
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right };
    });
    const centers = rects.map((r) => (r.left + r.right) / 2);
    const timelineLeft = timelineRef.current?.getBoundingClientRect().left ?? 0;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSelectedId(block.id);
    setDrag({
      kind: 'reorder',
      id: block.id,
      startX: e.clientX,
      originIdx,
      targetIdx: originIdx,
      deltaX: 0,
      centers,
      rects,
      timelineLeft,
    });
  };

  // --- Resize via pointer --------------------------------------------------
  const onResizePointerDown = (
    e: React.PointerEvent<HTMLDivElement>,
    block: Block,
  ) => {
    if (!editable) return;
    e.stopPropagation();
    const rect = blockRefs.current.get(block.id)?.getBoundingClientRect();
    const widthPx = rect?.width ?? 1;
    const pxPerMin = widthPx / Math.max(1, block.duration_sec / 60);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSelectedId(block.id);
    setDrag({
      kind: 'resize',
      id: block.id,
      startX: e.clientX,
      startDuration: block.duration_sec,
      pxPerMin,
    });
  };

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (drag.kind === 'idle') return;
      if (drag.kind === 'resize') {
        const deltaPx = e.clientX - drag.startX;
        const deltaMin = deltaPx / drag.pxPerMin;
        const nextMin = clampMin(Math.round(drag.startDuration / 60 + deltaMin));
        const current = blocks.find((b) => b.id === drag.id);
        if (!current) return;
        if (nextMin * 60 === current.duration_sec) return;
        onChange?.(
          blocks.map((b) =>
            b.id === drag.id ? { ...b, duration_sec: nextMin * 60 } : b,
          ),
        );
      }
      if (drag.kind === 'reorder') {
        const deltaX = e.clientX - drag.startX;
        const visualCenter = drag.centers[drag.originIdx] + deltaX;
        let targetIdx = 0;
        for (let i = 0; i < drag.centers.length; i++) {
          if (i === drag.originIdx) continue;
          if (drag.centers[i] < visualCenter) targetIdx++;
        }
        if (deltaX === drag.deltaX && targetIdx === drag.targetIdx) return;
        setDrag({ ...drag, deltaX, targetIdx });
      }
    },
    [drag, blocks, onChange],
  );

  const endDrag = useCallback(() => {
    setDrag((prev) => {
      if (prev.kind === 'reorder' && prev.targetIdx !== prev.originIdx) {
        const next = [...blocks];
        const [moved] = next.splice(prev.originIdx, 1);
        next.splice(prev.targetIdx, 0, moved);
        onChange?.(next);
      }
      return { kind: 'idle' };
    });
  }, [blocks, onChange]);

  // Stable ref wrappers so the useEffect below only re-attaches listeners when
  // drag starts or stops — not on every pointer-move tick that recreates the
  // callbacks above (which would create a brief gap where pointerup is missed).
  const onPointerMoveRef = useRef(onPointerMove);
  onPointerMoveRef.current = onPointerMove;
  const endDragRef = useRef(endDrag);
  endDragRef.current = endDrag;

  useEffect(() => {
    if (drag.kind === 'idle') return;
    const handleMove = (e: PointerEvent) => onPointerMoveRef.current(e);
    const handleEnd = () => endDragRef.current();
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleEnd);
    window.addEventListener('pointercancel', handleEnd);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleEnd);
      window.removeEventListener('pointercancel', handleEnd);
    };
  }, [drag.kind]);

  // Deselect when clicking outside any block.
  useEffect(() => {
    if (!selectedId) return;
    const onDocDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-role="block"]')) return;
      setSelectedId(null);
      setEditingId(null);
    };
    window.addEventListener('pointerdown', onDocDown);
    return () => window.removeEventListener('pointerdown', onDocDown);
  }, [selectedId]);

  // Keyboard shortcuts for the selected block.
  useEffect(() => {
    if (!editable || !selectedId) return;
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      const typing =
        tgt?.tagName === 'INPUT' ||
        tgt?.tagName === 'TEXTAREA' ||
        tgt?.isContentEditable === true;
      if (typing) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        onDelete?.(selectedId);
        setSelectedId(null);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        setEditingId(selectedId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editable, selectedId, onDelete]);

  const cyclePosture = (block: Block) => {
    const i = POSTURE_ORDER.indexOf(block.posture);
    const next = POSTURE_ORDER[(i + 1) % POSTURE_ORDER.length];
    onChange?.(blocks.map((b) => (b.id === block.id ? { ...b, posture: next } : b)));
  };

  const commitName = (id: string, name: string) => {
    const trimmed = name.trim();
    setEditingId(null);
    if (!trimmed) return;
    onChange?.(blocks.map((b) => (b.id === id ? { ...b, name: trimmed } : b)));
  };

  // Ruler ticks: every 15 min for <120 min total, otherwise 30 min.
  const step = totalMin > 120 ? 30 : totalMin > 60 ? 15 : 10;
  const ticks: number[] = [];
  for (let t = 0; t <= totalMin; t += step) ticks.push(t);
  if (ticks[ticks.length - 1] !== Math.round(totalMin)) {
    ticks.push(Math.round(totalMin));
  }

  const dropIndicatorX = useMemo(() => {
    if (drag.kind !== 'reorder') return null;
    if (drag.targetIdx === drag.originIdx) return null;
    const remaining = drag.rects.filter((_, i) => i !== drag.originIdx);
    if (remaining.length === 0) return null;
    let viewportX: number;
    if (drag.targetIdx <= 0) viewportX = remaining[0].left - 2;
    else if (drag.targetIdx >= remaining.length)
      viewportX = remaining[remaining.length - 1].right + 2;
    else
      viewportX =
        (remaining[drag.targetIdx - 1].right + remaining[drag.targetIdx].left) / 2;
    return viewportX - drag.timelineLeft;
  }, [drag]);

  const ctxMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!ctxMenu) return [];
    const b = ctxMenu.block;
    const items: ContextMenuItem[] = [
      {
        kind: 'action',
        label: 'Rename',
        shortcut: '⏎',
        onSelect: () => setEditingId(b.id),
      },
      {
        kind: 'action',
        label: `Cycle posture (${b.posture})`,
        onSelect: () => cyclePosture(b),
      },
      { kind: 'separator' },
      {
        kind: 'action',
        label: 'Delete',
        tone: 'danger',
        shortcut: '⌫',
        disabled: blocks.length <= 1,
        onSelect: () => {
          onDelete?.(b.id);
          setSelectedId(null);
        },
      },
    ];
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxMenu, blocks.length, onDelete]);

  return (
    <div className="pom-timeline-wrap" data-testid="pom-timeline">
      <div
        className="pom-timeline"
        ref={timelineRef}
        data-dragging={drag.kind !== 'idle'}
      >
        {blocks.map((block, idx) => {
          const flexGrow = block.duration_sec / 60;
          const isCurrent = mode === 'playing' && idx === currentIdx;
          const isDone = mode === 'playing' && currentIdx !== undefined && idx < currentIdx;
          const state = isCurrent ? 'current' : isDone ? 'done' : 'pending';
          const dragging = drag.kind !== 'idle' && drag.id === block.id;
          const translateX =
            drag.kind === 'reorder' && drag.id === block.id ? drag.deltaX : 0;
          const pct =
            isCurrent && progress !== undefined
              ? `${Math.max(0, Math.min(1, progress)) * 100}%`
              : isDone
                ? '100%'
                : '0%';

          return (
            <div
              key={block.id}
              ref={(el) => {
                if (el) blockRefs.current.set(block.id, el);
                else blockRefs.current.delete(block.id);
              }}
              data-role="block"
              data-testid={`pom-block-${block.id}`}
              data-posture={block.posture}
              data-selected={editable && selectedId === block.id}
              data-dragging={dragging}
              data-state={state}
              className="pom-block"
              style={
                {
                  flex: `${flexGrow} 1 0`,
                  ['--pom-progress' as string]: pct,
                  transform: translateX ? `translateX(${translateX}px)` : undefined,
                } as React.CSSProperties
              }
              onPointerDown={(e) => onBlockPointerDown(e, block)}
              onDoubleClick={() => editable && setEditingId(block.id)}
              onContextMenu={(e) => {
                if (!editable) return;
                e.preventDefault();
                setSelectedId(block.id);
                setCtxMenu({ x: e.clientX, y: e.clientY, block });
              }}
              onClick={() => {
                if (mode === 'playing') onJumpTo?.(idx);
              }}
              role={mode === 'playing' ? 'button' : undefined}
              aria-label={`${block.name} · ${Math.round(block.duration_sec / 60)}m · ${block.posture}`}
            >
              <div className="pom-block-progress" aria-hidden />
              <div className="pom-block-name">
                {editingId === block.id ? (
                  <Input
                    data-role="no-drag"
                    autoFocus
                    defaultValue={block.name}
                    onBlur={(e) => commitName(block.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitName(block.id, (e.target as HTMLInputElement).value);
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        setEditingId(null);
                      }
                    }}
                    className="pom-name-input"
                    style={{ fontSize: 12, width: '100%' }}
                    aria-label="Block name"
                    size="sm"
                  />
                ) : (
                  block.name
                )}
              </div>
              <div className="pom-block-meta">
                <span data-role="no-drag" onPointerDown={(e) => e.stopPropagation()}>
                  <IconButton
                    onClick={(e) => {
                      e.stopPropagation();
                      if (editable) cyclePosture(block);
                    }}
                    title={editable ? 'Click to cycle posture' : block.posture}
                    tooltipSide="bottom"
                    stopPropagation={false}
                  >
                    <span
                      aria-label={`Posture: ${block.posture}`}
                      style={{ fontSize: 11, cursor: editable ? 'pointer' : 'default' }}
                    >
                      {POSTURE_EMOJI[block.posture]}
                    </span>
                  </IconButton>
                </span>
                <span>{Math.round(block.duration_sec / 60)}m</span>
              </div>
              {editable && (
                <div
                  data-role="resize"
                  className="pom-resize"
                  onPointerDown={(e) => onResizePointerDown(e, block)}
                  aria-hidden
                />
              )}
            </div>
          );
        })}
        {dropIndicatorX !== null && (
          <div
            className="pom-drop-indicator"
            style={{ left: dropIndicatorX }}
            aria-hidden
          />
        )}
      </div>
      <div className="pom-ruler" aria-hidden>
        {ticks.map((t) => (
          <span
            key={t}
            className="pom-ruler-tick"
            style={{ left: `${(t / totalMin) * 100}%` }}
          >
            {t}m
          </span>
        ))}
      </div>
      <ContextMenu
        open={ctxMenu !== null}
        x={ctxMenu?.x ?? 0}
        y={ctxMenu?.y ?? 0}
        items={ctxMenuItems}
        onClose={() => setCtxMenu(null)}
        label="Block actions"
      />
    </div>
  );
};
