import { useCallback, useEffect, useState } from 'react';

/// Side of a drop target the pointer is hovering over. Maps to
/// "insert before" / "insert after" semantics in the grid.
export type DropSide = 'before' | 'after';

export type TileDragState = {
  /// Id of the tile currently being dragged.
  sourceId: string;
  /// Tile id under the pointer, if any. `null` while hovering empty
  /// space.
  targetId: string | null;
  /// Which half of the target tile the pointer is on. Meaningless
  /// when `targetId === null`.
  side: DropSide;
  /// Pointer coordinates — surfaced for the floating drag ghost.
  x: number;
  y: number;
};

type Commit = (sourceId: string, targetId: string, side: DropSide) => void;

type UseTileReorderReturn = {
  dragState: TileDragState | null;
  /// Pointer-down handler factory for a draggable tile. Drag only
  /// engages after the pointer moves more than 5 px — plain clicks
  /// still fire normally.
  beginDrag: (sourceId: string) => (e: React.PointerEvent) => void;
};

const DRAG_THRESHOLD_PX = 5;

const findTileUnderPoint = (
  x: number,
  y: number,
): { id: string; rect: DOMRect } | null => {
  const hits = document.elementsFromPoint(x, y);
  for (const el of hits) {
    const target = (el as HTMLElement).closest?.('[data-tile-id]');
    if (target) {
      const id = target.getAttribute('data-tile-id');
      if (id) return { id, rect: target.getBoundingClientRect() };
    }
  }
  return null;
};

const sideForPoint = (x: number, rect: DOMRect): DropSide =>
  x - rect.left < rect.width / 2 ? 'before' : 'after';

/// Pointer-based tile reorder. HTML5 drag-and-drop is flaky in
/// WKWebView (Tauri's macOS webview); the rest of Stash already
/// uses pointer events for the same reason — see
/// `src/modules/terminal/hooks/useDrag.ts` for the canonical
/// reference.
///
/// Consumers mark each tile with `data-tile-id="<id>"` and wire the
/// returned `beginDrag(id)` into their `onPointerDown`. The hook
/// stays free of business logic — it surfaces drag state and
/// invokes `commitDrop` on release; deciding how to mutate the
/// stored order is the consumer's job.
export const useTileReorder = (commitDrop: Commit): UseTileReorderReturn => {
  const [dragState, setDragState] = useState<TileDragState | null>(null);

  // Clear stale state if the component using us unmounts mid-drag —
  // the document listeners below would otherwise call `setDragState`
  // on a dead instance.
  useEffect(() => () => setDragState(null), []);

  const beginDrag = useCallback(
    (sourceId: string) => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const startX = e.clientX;
      const startY = e.clientY;
      let armed = false;

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!armed && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        armed = true;
        const hit = findTileUnderPoint(ev.clientX, ev.clientY);
        if (!hit || hit.id === sourceId) {
          setDragState({
            sourceId,
            targetId: null,
            side: 'before',
            x: ev.clientX,
            y: ev.clientY,
          });
          return;
        }
        setDragState({
          sourceId,
          targetId: hit.id,
          side: sideForPoint(ev.clientX, hit.rect),
          x: ev.clientX,
          y: ev.clientY,
        });
      };

      const finish = (ev: PointerEvent) => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', finish);
        document.removeEventListener('pointercancel', cancel);
        if (!armed) {
          setDragState(null);
          return;
        }
        const hit = findTileUnderPoint(ev.clientX, ev.clientY);
        setDragState(null);
        if (!hit || hit.id === sourceId) return;
        commitDrop(sourceId, hit.id, sideForPoint(ev.clientX, hit.rect));
      };

      const cancel = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', finish);
        document.removeEventListener('pointercancel', cancel);
        setDragState(null);
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', finish);
      document.addEventListener('pointercancel', cancel);
    },
    [commitDrop],
  );

  return { dragState, beginDrag };
};
