import { useEffect, useRef, useState } from 'react';
import { IconButton } from '../../shared/ui/IconButton';
import { EyeIcon, TrashIcon } from '../../shared/ui/icons';
import { accent } from '../../shared/theme/accent';
import { canvasStore } from './store';
import { TOOL_BY_KIND } from './tools';
import type { CanvasNode, CanvasProject } from './types';

const Mini = ({ d }: { d: string }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const EyeOff = () => <Mini d="M3 3l18 18M10.6 10.7a2 2 0 0 0 2.8 2.8M9.4 5.3A9 9 0 0 1 21 12a16 16 0 0 1-2.2 3M6.1 6.2A16 16 0 0 0 3 12a9 9 0 0 0 12 6.4" />;
const LockOpen = () => <Mini d="M7 11V8a5 5 0 0 1 9.6-2M5 11h14v10H5zM12 15v3" />;
const LockClosed = () => <Mini d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5zM12 15v3" />;
const GripIcon = () => <Mini d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" />;

const nodeLabel = (n: CanvasNode) =>
  n.tool === 'image' ? 'Image' : TOOL_BY_KIND[n.tool]?.title ?? n.name;

interface Props {
  project: CanvasProject;
  selectedIds: string[];
}

export const LayersPanel = ({ project, selectedIds }: Props) => {
  // Render top-most layer first (array is bottom-first).
  const rows = [...project.nodes].reverse();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const dragRef = useRef<string | null>(null);

  // Pointer-based reorder: WKWebView's native HTML5 drag-and-drop is unreliable,
  // so we track the drag ourselves on window pointer events and resolve the drop
  // target via elementFromPoint.
  useEffect(() => {
    if (!dragId) return;
    const rowIdAt = (x: number, y: number): string | null => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      return (el?.closest('[data-layer-id]') as HTMLElement | null)?.dataset.layerId ?? null;
    };
    const move = (e: PointerEvent) => setOverId(rowIdAt(e.clientX, e.clientY));
    const up = (e: PointerEvent) => {
      const from = dragRef.current;
      const to = rowIdAt(e.clientX, e.clientY);
      if (from && to && from !== to) {
        const topFirst = rows.map((n) => n.id).filter((id) => id !== from);
        const at = topFirst.indexOf(to);
        topFirst.splice(at < 0 ? topFirst.length : at, 0, from);
        // Store keeps nodes bottom-first → reverse the top-first view order.
        canvasStore.reorderNodes(project.id, [...topFirst].reverse());
      }
      dragRef.current = null;
      setDragId(null);
      setOverId(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [dragId, project.id, rows]);

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ userSelect: dragId ? 'none' : undefined }}>
      <div className="shrink-0 px-2.5 py-1.5 text-meta t-tertiary">Layers</div>
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {rows.length === 0 && (
          <div className="px-1.5 py-2 text-meta t-quaternary">
            No layers — draw or paste to add one
          </div>
        )}
        {rows.map((n) => {
          const selected = selectedIds.includes(n.id);
          return (
            <div
              key={n.id}
              data-layer-id={n.id}
              className="group flex items-center gap-1 rounded-md px-1 py-1"
              style={{
                background: selected ? accent(0.14) : undefined,
                boxShadow: overId === n.id && dragId && dragId !== n.id ? `inset 0 2px 0 ${accent(0.9)}` : undefined,
                opacity: dragId === n.id ? 0.5 : 1,
              }}
            >
              <span
                onPointerDown={(e) => {
                  e.preventDefault();
                  dragRef.current = n.id;
                  setDragId(n.id);
                }}
                className="cursor-grab text-[color:var(--color-text-tertiary)] opacity-50 transition-opacity hover:opacity-100 group-hover:opacity-100"
                style={{ touchAction: 'none' }}
                title="Drag to reorder"
              >
                <GripIcon />
              </span>
              <IconButton
                title={n.visible ? 'Hide layer' : 'Show layer'}
                onClick={() => canvasStore.toggleVisible(project.id, n.id)}
              >
                {n.visible ? <EyeIcon /> : <EyeOff />}
              </IconButton>
              <button
                type="button"
                onClick={() => canvasStore.setSelected(project.id, [n.id])}
                className="min-w-0 flex-1 truncate text-left text-body t-secondary"
                style={selected ? { color: 'var(--color-text-primary)' } : undefined}
              >
                {nodeLabel(n)}
              </button>
              <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                <IconButton
                  title={n.locked ? 'Unlock layer' : 'Lock layer'}
                  onClick={() => canvasStore.toggleLocked(project.id, n.id)}
                >
                  {n.locked ? <LockClosed /> : <LockOpen />}
                </IconButton>
                <IconButton title="Delete layer" tone="danger" onClick={() => canvasStore.removeNodes(project.id, [n.id])}>
                  <TrashIcon />
                </IconButton>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
