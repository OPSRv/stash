import { useEffect, useRef, useState, type RefObject } from 'react';

/** Pointer-events-based drag-and-drop for the Notes module. The HTML5 drag
 *  API is unreliable inside Tauri's WKWebView (the OS-level drag delegate
 *  intercepts events before the WebView sees them, and `dataTransfer.types`
 *  is stripped of custom MIME during dragover). Pointer events bypass all
 *  of that — they're plain mouse/touch input that React handles directly. */

export type DragInfo =
  | { kind: 'note'; id: number }
  | { kind: 'folder'; id: number };

type Listener = (info: DragInfo | null) => void;

let activeDrag: DragInfo | null = null;
const subs = new Set<Listener>();

const setActiveDrag = (next: DragInfo | null) => {
  activeDrag = next;
  for (const s of subs) s(next);
};

export const getActiveDrag = () => activeDrag;

/** Subscribe to active-drag changes. Returns the live value as React state. */
export const useActiveDrag = (): DragInfo | null => {
  const [v, setV] = useState<DragInfo | null>(activeDrag);
  useEffect(() => {
    subs.add(setV);
    return () => {
      subs.delete(setV);
    };
  }, []);
  return v;
};

/** Distance the pointer has to travel before a click turns into a drag. */
const DRAG_THRESHOLD_PX = 5;

/** Attach pointer-based drag to a DOM element. The drag is "armed" on
 *  pointerdown, "started" once the pointer moves past the threshold, and
 *  "completed" on pointerup. While dragging, the element under the cursor
 *  is queried via `elementFromPoint` and the closest ancestor carrying
 *  `data-drop-zone` decides where the drop lands.
 *
 *  `onDrop(target)` receives the parsed drop zone or `null` if the user
 *  released the pointer outside any registered target. */
export type DropTargetData =
  | { kind: 'note-into'; folderId: number | null; label: string }
  | { kind: 'folder-reorder'; overId: number; clientY: number; rect: DOMRect };

const parseTarget = (
  el: Element | null,
  clientY: number,
  drag: DragInfo,
): DropTargetData | null => {
  if (!el) return null;
  const target = el.closest('[data-drop-zone]') as HTMLElement | null;
  if (!target) return null;
  const raw = target.dataset.dropZone ?? '';
  const rect = target.getBoundingClientRect();
  if (drag.kind === 'note') {
    if (raw === 'all' || raw === 'unfiled') {
      return {
        kind: 'note-into',
        folderId: null,
        label: raw === 'all' ? 'All notes' : 'Unfiled',
      };
    }
    const m = raw.match(/^folder:(\d+):(.*)$/);
    if (m) {
      return {
        kind: 'note-into',
        folderId: Number(m[1]),
        label: m[2] || 'Folder',
      };
    }
    return null;
  }
  // drag.kind === 'folder' — only folder rows are valid drop targets here.
  const m = raw.match(/^folder:(\d+):/);
  if (!m) return null;
  const overId = Number(m[1]);
  if (overId === drag.id) return null;
  return { kind: 'folder-reorder', overId, clientY, rect };
};

/** Hook that wires a draggable element. Returns `{ ref, isDragging }`.
 *  `onDrop` receives the parsed drop target plus the source drag info so
 *  callers don't have to chase down state at drop time. */
export const usePointerDrag = (
  info: DragInfo,
  onDrop: (target: DropTargetData | null, source: DragInfo) => void,
): {
  ref: RefObject<HTMLDivElement | null>;
  isDragging: boolean;
} => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [isDragging, setDragging] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    let startX = 0;
    let startY = 0;
    let armed = false;
    let started = false;

    const cleanup = () => {
      armed = false;
      started = false;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      document.body.style.userSelect = '';
      setActiveDrag(null);
      setDragging(false);
    };

    const onMove = (e: PointerEvent) => {
      if (!armed) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!started) {
        if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        started = true;
        setActiveDrag(info);
        setDragging(true);
        // Block native text selection while the user drags between rows.
        document.body.style.userSelect = 'none';
      }
      // Re-query the element under the cursor so drop highlight updates
      // live. We fire a custom event the row hooks listen for so each
      // target can decide its own visual state without a global subscription.
      const el = document.elementFromPoint(e.clientX, e.clientY);
      window.dispatchEvent(
        new CustomEvent('stash:notes-dnd-move', {
          detail: { clientX: e.clientX, clientY: e.clientY, el },
        }),
      );
    };

    const onUp = (e: PointerEvent) => {
      if (!armed) return;
      const wasStarted = started;
      const drag = activeDrag;
      // Resolve the drop target BEFORE cleanup tears down state so the
      // window event listeners (which clear visual highlights) don't run
      // before we've parsed the cursor target.
      const target = wasStarted && drag
        ? parseTarget(document.elementFromPoint(e.clientX, e.clientY), e.clientY, drag)
        : null;
      cleanup();
      if (!wasStarted || !drag) return;
      window.dispatchEvent(new CustomEvent('stash:notes-dnd-end'));
      onDrop(target, drag);
    };

    const onDown = (e: PointerEvent) => {
      // Left button only. Buttons + text fields inside the row should still
      // work normally — they'll handle their own clicks before we promote to
      // a drag (the threshold gives us a no-op window).
      if (e.button !== 0) return;
      const tgt = e.target as HTMLElement | null;
      // Skip when the pointer landed on something interactive that should
      // own the gesture (input, button, link, [contenteditable]).
      if (
        tgt?.closest(
          'input, textarea, button, a, [contenteditable="true"], [contenteditable=""], [data-no-drag]',
        )
      ) {
        return;
      }
      armed = true;
      started = false;
      startX = e.clientX;
      startY = e.clientY;
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    };

    node.addEventListener('pointerdown', onDown);
    return () => {
      node.removeEventListener('pointerdown', onDown);
      cleanup();
    };
  }, [info.kind, info.id, onDrop]);

  return { ref, isDragging };
};

/** Hook that turns a DOM node into a drop target. The node must carry a
 *  `data-drop-zone` attribute; this hook only manages the live "is the
 *  pointer currently over me?" state by listening to the cursor-move event
 *  the drag-source hook dispatches on every pointermove. */
export const useIsDropTarget = (
  ref: RefObject<HTMLElement | null>,
): boolean => {
  const [over, setOver] = useState(false);
  useEffect(() => {
    const onMove = (e: Event) => {
      const detail = (e as CustomEvent).detail as { el: Element | null };
      const node = ref.current;
      if (!node) return;
      const cur = detail.el?.closest('[data-drop-zone]') ?? null;
      setOver(cur === node);
    };
    const onEnd = () => setOver(false);
    window.addEventListener('stash:notes-dnd-move', onMove);
    window.addEventListener('stash:notes-dnd-end', onEnd);
    return () => {
      window.removeEventListener('stash:notes-dnd-move', onMove);
      window.removeEventListener('stash:notes-dnd-end', onEnd);
    };
  }, [ref]);
  return over;
};
