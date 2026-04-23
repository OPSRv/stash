import { useCallback, useState } from 'react';

import type { DragSource, DragState, DropPosition } from '../types';

type CommitDrop = (
  source: DragSource,
  target: string,
  zone: DropPosition,
) => void;

type UseDragReturn = {
  dragState: DragState | null;
  /// Callback for onPointerDown on a draggable element. Threshold-gated
  /// (drag only begins after the pointer moves >5 px) so plain clicks
  /// still fire normally.
  beginDrag: (source: DragSource, label: string) => (e: React.PointerEvent) => void;
  /// Id of the tab currently under the pointer (if any) — wired into
  /// the tab bar so the active drop target gets an accent wash.
  dropOverTab: string;
};

/// Walk up from the element under the cursor and return the first
/// ancestor that advertises itself as a drop target via `data-drop-target`.
const findDropTarget = (
  x: number,
  y: number,
): { id: string; rect: DOMRect } | null => {
  const hits = document.elementsFromPoint(x, y);
  for (const el of hits) {
    const target = (el as HTMLElement).closest?.('[data-drop-target]');
    if (target) {
      const raw = target.getAttribute('data-drop-target');
      if (raw) return { id: raw, rect: target.getBoundingClientRect() };
    }
  }
  return null;
};

/// Edge-aware zone detection.
/// - Tab-on-tab: left / right half decides insert-before vs insert-after
///   so a drop-line indicator can be drawn on the correct edge. Still
///   resolves to a single axis (horizontal tab strip).
/// - Pane-on-tab: always `center` — pane drops onto a tab mean "move
///   into this tab", no edge semantics.
/// - Pane-on-pane: four-edge tiling (left/right/top/bottom) with a
///   generous center zone for swaps.
export const zoneFromPoint = (
  x: number,
  y: number,
  rect: DOMRect,
  kind: 'tab' | 'pane',
  sourceKind: 'tab' | 'pane' = 'pane',
): DropPosition => {
  if (kind === 'tab') {
    if (sourceKind !== 'tab') return 'center';
    const rx = (x - rect.left) / rect.width;
    return rx < 0.5 ? 'left' : 'right';
  }
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  const EDGE = 0.2;
  if (rx < EDGE) return 'left';
  if (rx > 1 - EDGE) return 'right';
  if (ry < EDGE) return 'top';
  if (ry > 1 - EDGE) return 'bottom';
  return 'center';
};

/// Pointer-based drag manager. Replaces HTML5 DnD, which is flaky inside
/// WKWebView (Tauri's macOS webview). Drop targets opt in by setting
/// `data-drop-target="tab:<id>" | "pane:<id>"` on any element; the hook
/// walks up from the cursor via `elementsFromPoint` to find the nearest
/// opt-in ancestor.
///
/// The caller supplies a `commitDrop` that decides what a concrete
/// (source, target, zone) triple means for the tab state — keeps this
/// hook free of business logic.
export const useDrag = (commitDrop: CommitDrop): UseDragReturn => {
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [dropOverTab, setDropOverTab] = useState<string>('');

  const beginDrag = useCallback(
    (source: DragSource, label: string) => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const startX = e.clientX;
      const startY = e.clientY;
      let active = false;

      const sourceKind: 'tab' | 'pane' = source.startsWith('tab:') ? 'tab' : 'pane';
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!active && Math.hypot(dx, dy) < 5) return;
        active = true;

        const hit = findDropTarget(ev.clientX, ev.clientY);
        let zone: DropPosition = 'center';
        let targetId: string | null = null;
        if (hit) {
          const kind = hit.id.startsWith('tab:') ? 'tab' : 'pane';
          zone = zoneFromPoint(ev.clientX, ev.clientY, hit.rect, kind, sourceKind);
          targetId = hit.id;
        }
        setDragState({
          source,
          x: ev.clientX,
          y: ev.clientY,
          target: targetId,
          zone,
          label,
        });
        setDropOverTab(
          hit && hit.id.startsWith('tab:') ? hit.id.slice('tab:'.length) : '',
        );
      };

      const onUp = (ev: PointerEvent) => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        setDragState(null);
        setDropOverTab('');
        if (!active) return;
        const hit = findDropTarget(ev.clientX, ev.clientY);
        if (!hit) return;
        const kind = hit.id.startsWith('tab:') ? 'tab' : 'pane';
        const zone = zoneFromPoint(ev.clientX, ev.clientY, hit.rect, kind, sourceKind);
        commitDrop(source, hit.id, zone);
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    },
    [commitDrop],
  );

  return { dragState, beginDrag, dropOverTab };
};
