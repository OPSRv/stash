import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Konva from 'konva';
import { Layer, Rect, Stage, Transformer } from 'react-konva';
import { NodeView } from './NodeView';
import { canvasStore } from './store';
import {
  DEFAULT_STYLE,
  nid,
  type CanvasNode,
  type CanvasProject,
  type ImageNode,
  type ToolKind,
} from './types';
import { RECT_TOOLS, SEGMENT_TOOLS, TOOLS } from './tools';

export interface ContextMenuInfo {
  clientX: number;
  clientY: number;
  nodeId: string | null;
}

interface Props {
  project: CanvasProject;
  tool: ToolKind;
  selectedIds: string[];
  editingId: string | null;
  onContextMenu?: (info: ContextMenuInfo) => void;
}

export interface CanvasStageHandle {
  /** Flatten visible layers of the export region to a PNG data-URL. */
  toPng: (pixelRatio?: number) => string | null;
  /** Re-center & fit the export region in the viewport. */
  fit: () => void;
}

interface Draft {
  node: CanvasNode;
  startX: number;
  startY: number;
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const FREEHAND_TOOLS: ToolKind[] = ['freehand', 'eraser'];

/** Approximate, data-derived bounding box of one node (rotation ignored). */
const nodeBounds = (n: CanvasNode): Bounds => {
  if ('points' in n) {
    const pts = n.points;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]);
      maxX = Math.max(maxX, pts[i]);
      minY = Math.min(minY, pts[i + 1]);
      maxY = Math.max(maxY, pts[i + 1]);
    }
    if (!isFinite(minX)) return { x: n.x, y: n.y, width: 0, height: 0 };
    return { x: n.x + minX, y: n.y + minY, width: maxX - minX, height: maxY - minY };
  }
  if (n.tool === 'counter') return { x: n.x, y: n.y, width: n.radius * 2, height: n.radius * 2 };
  if (n.tool === 'text') {
    const fs = n.style.fontSize ?? 24;
    return { x: n.x, y: n.y, width: n.width || (n.text.length * fs * 0.55) || 80, height: fs * 1.4 };
  }
  const w = (n as { width?: number }).width ?? 0;
  const h = (n as { height?: number }).height ?? 0;
  return { x: n.x, y: n.y, width: w, height: h };
};

const unionBounds = (nodes: CanvasNode[]): Bounds | null => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    if (!n.visible) continue;
    const b = nodeBounds(n);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  if (!isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

export const CanvasStage = forwardRef<CanvasStageHandle, Props>(function CanvasStage(
  { project, tool, selectedIds, editingId, onContextMenu },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const nodeRefs = useRef<Map<string, Konva.Node>>(new Map());

  const [size, setSize] = useState({ width: 800, height: 600 });
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);

  const baseImage = useMemo(
    () => (project.nodes.find((n) => n.tool === 'image') as ImageNode | undefined) ?? null,
    [project.nodes],
  );

  // The exported area. With a backdrop, it grows to wrap all content + padding
  // (so dragging content out always stays inside the frame); otherwise it's the
  // page (= the base screenshot size).
  const region = useMemo<Bounds>(() => {
    const b = project.backdrop;
    if (b.enabled) {
      const content = unionBounds(project.nodes) ?? {
        x: 0,
        y: 0,
        width: project.width,
        height: project.height,
      };
      return {
        x: content.x - b.padding,
        y: content.y - b.padding,
        width: content.width + b.padding * 2,
        height: content.height + b.padding * 2,
      };
    }
    return { x: 0, y: 0, width: project.width, height: project.height };
  }, [project.nodes, project.backdrop, project.width, project.height]);

  const backdropFill = useMemo<Konva.NodeConfig | null>(() => {
    const b = project.backdrop;
    if (!b.enabled) return null;
    if (b.fill.kind === 'solid') return { fill: b.fill.color };
    const rad = (b.fill.angle * Math.PI) / 180;
    return {
      fillLinearGradientStartPoint: { x: 0, y: 0 },
      fillLinearGradientEndPoint: {
        x: region.width * Math.cos(rad),
        y: region.height * Math.sin(rad),
      },
      fillLinearGradientColorStops: [0, b.fill.from, 1, b.fill.to],
    };
  }, [project.backdrop, region.width, region.height]);

  // ---- sizing & fit ------------------------------------------------------
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    const pad = 48;
    const sw = size.width - pad * 2;
    const sh = size.height - pad * 2;
    if (sw <= 0 || sh <= 0 || region.width <= 0 || region.height <= 0) return;
    const scale = Math.min(sw / region.width, sh / region.height, 1);
    setView({
      scale,
      x: (size.width - region.width * scale) / 2 - region.x * scale,
      y: (size.height - region.height * scale) / 2 - region.y * scale,
    });
  }, [size, region.x, region.y, region.width, region.height]);

  // Auto-fit on project switch and once the container has a size.
  useEffect(() => {
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, size.width, size.height]);

  useImperativeHandle(
    ref,
    () => ({
      toPng: (pixelRatio = 2) => {
        const stage = stageRef.current;
        if (!stage) return null;
        const tr = trRef.current;
        const trVisible = tr?.visible() ?? false;
        tr?.visible(false);
        const prevScale = stage.scaleX();
        const prevPos = stage.position();
        stage.scale({ x: 1, y: 1 });
        stage.position({ x: 0, y: 0 });
        stage.batchDraw();
        let url: string | null = null;
        try {
          url = stage.toDataURL({
            x: region.x,
            y: region.y,
            width: region.width,
            height: region.height,
            pixelRatio,
          });
        } catch {
          url = null;
        }
        stage.scale({ x: prevScale, y: prevScale });
        stage.position(prevPos);
        if (tr && trVisible) tr.visible(true);
        stage.batchDraw();
        return url;
      },
      fit,
    }),
    [region.x, region.y, region.width, region.height, fit],
  );

  // ---- transformer follows selection ------------------------------------
  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    if (draft) {
      tr.nodes([]);
      return;
    }
    const nodes = selectedIds
      .map((id) => nodeRefs.current.get(id))
      .filter((n): n is Konva.Node => !!n);
    tr.nodes(nodes);
    tr.getLayer()?.batchDraw();
  }, [selectedIds, draft, project.nodes]);

  // ---- pointer helpers ---------------------------------------------------
  const relPoint = (): { x: number; y: number } =>
    stageRef.current?.getRelativePointerPosition() ?? { x: 0, y: 0 };

  const nextCounterValue = () => project.nodes.filter((n) => n.tool === 'counter').length + 1;

  const makeStartNode = (t: ToolKind, x: number, y: number): CanvasNode => {
    const base = {
      id: nid(t),
      name: TOOLS.find((td) => td.kind === t)?.title ?? t,
      visible: true,
      locked: false,
      x,
      y,
      rotation: 0,
      style: { ...DEFAULT_STYLE },
    };
    if (RECT_TOOLS.includes(t)) return { ...base, tool: t, width: 1, height: 1 } as CanvasNode;
    if (SEGMENT_TOOLS.includes(t)) return { ...base, tool: t, points: [0, 0, 0, 0] } as CanvasNode;
    if (FREEHAND_TOOLS.includes(t)) return { ...base, tool: t, points: [0, 0] } as CanvasNode;
    return { ...base, tool: t, width: 1, height: 1 } as CanvasNode;
  };

  // ---- drawing -----------------------------------------------------------
  const onMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    // Take keyboard focus so ⌘Z / Delete / tool keys reach this surface.
    containerRef.current?.focus();
    if (spaceDown || e.evt.button === 2) return; // panning / right-click
    const clickedEmpty = e.target === e.target.getStage() || e.target.name() === 'backdrop';

    if (tool === 'select') {
      if (clickedEmpty) canvasStore.setSelected(project.id, []);
      return;
    }
    const { x, y } = relPoint();

    if (tool === 'text') {
      const node: CanvasNode = {
        id: nid('text'),
        tool: 'text',
        name: 'Text',
        visible: true,
        locked: false,
        x,
        y,
        rotation: 0,
        text: '',
        width: 0,
        style: { ...DEFAULT_STYLE, fontSize: 28 },
      };
      canvasStore.addNode(project.id, node);
      canvasStore.setEditing(project.id, node.id);
      return;
    }
    if (tool === 'counter') {
      const r = 18;
      const v = nextCounterValue();
      const node: CanvasNode = {
        id: nid('counter'),
        tool: 'counter',
        name: `Counter ${v}`,
        visible: true,
        locked: false,
        x: x - r,
        y: y - r,
        rotation: 0,
        value: v,
        radius: r,
        style: { ...DEFAULT_STYLE, fill: DEFAULT_STYLE.stroke },
      };
      canvasStore.addNode(project.id, node);
      return;
    }
    setDraft({ node: makeStartNode(tool, x, y), startX: x, startY: y });
  };

  const onMouseMove = () => {
    if (!draft) return;
    const { x, y } = relPoint();
    const d = draft;
    let node = d.node;
    if (RECT_TOOLS.includes(node.tool as ToolKind)) {
      node = {
        ...node,
        x: Math.min(d.startX, x),
        y: Math.min(d.startY, y),
        width: Math.abs(x - d.startX),
        height: Math.abs(y - d.startY),
      } as CanvasNode;
    } else if (SEGMENT_TOOLS.includes(node.tool as ToolKind)) {
      node = { ...node, points: [0, 0, x - d.startX, y - d.startY] } as CanvasNode;
    } else if (FREEHAND_TOOLS.includes(node.tool as ToolKind)) {
      const pts = (node as { points: number[] }).points.concat([x - d.startX, y - d.startY]);
      node = { ...node, points: pts } as CanvasNode;
    }
    setDraft({ ...d, node });
  };

  const onMouseUp = () => {
    if (!draft) return;
    const node = draft.node;
    const tooSmall =
      RECT_TOOLS.includes(node.tool as ToolKind) &&
      (node as { width: number; height: number }).width < 3 &&
      (node as { width: number; height: number }).height < 3;
    setDraft(null);
    if (tooSmall) return;
    canvasStore.addNode(project.id, node);
  };

  // ---- zoom / pan --------------------------------------------------------
  // Figma-style: trackpad two-finger scroll (or mouse wheel) pans; pinch or
  // ⌘/Ctrl + wheel zooms toward the cursor.
  const onWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const zoomGesture = e.evt.ctrlKey || e.evt.metaKey;
    if (zoomGesture) {
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      const old = view.scale;
      const next = Math.min(8, Math.max(0.05, old * Math.exp(-e.evt.deltaY * 0.01)));
      const mouseTo = { x: (pointer.x - view.x) / old, y: (pointer.y - view.y) / old };
      setView({ scale: next, x: pointer.x - mouseTo.x * next, y: pointer.y - mouseTo.y * next });
    } else {
      setView((v) => ({ ...v, x: v.x - e.evt.deltaX, y: v.y - e.evt.deltaY }));
    }
  };

  // ---- transform end (bake scale into geometry) -------------------------
  const onTransformEnd = () => {
    const tr = trRef.current;
    if (!tr) return;
    for (const kn of tr.nodes()) {
      const id = [...nodeRefs.current.entries()].find(([, v]) => v === kn)?.[0];
      if (!id) continue;
      const node = project.nodes.find((n) => n.id === id);
      if (!node) continue;
      const sx = kn.scaleX();
      const sy = kn.scaleY();
      kn.scaleX(1);
      kn.scaleY(1);
      const patch: Partial<CanvasNode> = { x: kn.x(), y: kn.y(), rotation: kn.rotation() };
      if ('width' in node) {
        (patch as { width: number; height: number }).width = Math.max(5, (node as { width: number }).width * sx);
        (patch as { width: number; height: number }).height = Math.max(5, (node as { height: number }).height * sy);
        if (node.tool === 'oval') {
          patch.x = kn.x() - ((node as { width: number }).width * sx) / 2;
          patch.y = kn.y() - ((node as { height: number }).height * sy) / 2;
        }
      } else if ('points' in node) {
        (patch as { points: number[] }).points = (node as { points: number[] }).points.map(
          (p, i) => p * (i % 2 === 0 ? sx : sy),
        );
      }
      if (node.tool === 'counter') {
        (patch as { radius: number }).radius = (node as { radius: number }).radius * Math.max(sx, sy);
      }
      if (node.tool === 'text') {
        patch.style = { ...node.style, fontSize: (node.style.fontSize ?? 24) * sy };
        (patch as { width: number }).width = ((node as { width: number }).width || 0) * sx;
      }
      canvasStore.updateNode(project.id, id, patch);
    }
  };

  // Keyboard is handled at the window level in CanvasShell (so ⌘V/⌘Z/etc. work
  // the moment the tab is open, without clicking the canvas first). Here we only
  // track Space for pan, and only while this stage actually has focus.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && document.activeElement === containerRef.current) setSpaceDown(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const editingNode = editingId
    ? (project.nodes.find((n) => n.id === editingId) as CanvasNode | undefined)
    : undefined;

  const cursor = spaceDown ? 'grab' : tool === 'select' ? 'default' : 'crosshair';
  const b = project.backdrop;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onContextMenu={(e) => {
        e.preventDefault();
        const stage = stageRef.current;
        let nodeId: string | null = null;
        const pos = stage?.getPointerPosition();
        if (stage && pos) {
          let n: Konva.Node | null = stage.getIntersection(pos);
          while (n) {
            const found = [...nodeRefs.current.entries()].find(([, v]) => v === n);
            if (found) {
              nodeId = found[0];
              break;
            }
            n = n.getParent();
          }
        }
        if (nodeId && !selectedIds.includes(nodeId)) canvasStore.setSelected(project.id, [nodeId]);
        onContextMenu?.({ clientX: e.clientX, clientY: e.clientY, nodeId });
      }}
      className="relative h-full w-full outline-none"
      style={{
        cursor,
        // Subtle checkerboard so transparent PNGs / erased areas read as empty.
        backgroundColor: 'var(--color-bg-canvas)',
        backgroundImage:
          'repeating-conic-gradient(rgba(140,140,140,0.10) 0% 25%, transparent 0% 50%)',
        backgroundSize: '20px 20px',
      }}
    >
      <Stage
        ref={stageRef}
        width={size.width}
        height={size.height}
        scaleX={view.scale}
        scaleY={view.scale}
        x={view.x}
        y={view.y}
        draggable={spaceDown}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onWheel={onWheel}
        onDragEnd={(e) => {
          if (e.target === stageRef.current) {
            setView((v) => ({ ...v, x: e.target.x(), y: e.target.y() }));
          }
        }}
      >
        <Layer>
          {/* page / backdrop frame */}
          <Rect
            name="backdrop"
            x={region.x}
            y={region.y}
            width={region.width}
            height={region.height}
            cornerRadius={b.enabled ? b.radius : 0}
            stroke={b.enabled ? (b.border ? b.borderColor : undefined) : 'rgba(150,150,150,0.5)'}
            strokeWidth={b.enabled ? b.border : 1}
            dash={b.enabled ? undefined : [6, 4]}
            shadowColor="#000000"
            shadowBlur={b.enabled ? 40 : 0}
            shadowOpacity={0.18}
            {...(backdropFill ?? {})}
          />
          {project.nodes
            .filter((n) => n.visible)
            .map((node) => (
              <NodeView
                key={node.id}
                node={node}
                baseImage={baseImage}
                draggable={tool === 'select' && !node.locked && !spaceDown}
                onSelect={(id, additive) => {
                  const cur = additive ? selectedIds : [];
                  canvasStore.setSelected(
                    project.id,
                    additive ? [...new Set([...cur, id])] : [id],
                  );
                }}
                onChange={(id, patch) => canvasStore.updateNodeLive(project.id, id, patch)}
                onDragStart={() => canvasStore.beginHistory(project.id)}
                onDragMove={(id, patch) => canvasStore.updateNodeLive(project.id, id, patch)}
                onStartEdit={(id) => canvasStore.setEditing(project.id, id)}
                registerRef={(id, n) => {
                  if (n) nodeRefs.current.set(id, n);
                  else nodeRefs.current.delete(id);
                }}
              />
            ))}
          {draft && (
            <NodeView
              node={draft.node}
              baseImage={baseImage}
              draggable={false}
              onSelect={() => {}}
              onChange={() => {}}
              onDragStart={() => {}}
              onDragMove={() => {}}
              onStartEdit={() => {}}
              registerRef={() => {}}
            />
          )}
          {tool === 'select' && !draft && (
            <Transformer
              ref={trRef}
              rotateEnabled
              onTransformEnd={onTransformEnd}
              boundBoxFunc={(oldBox, newBox) =>
                newBox.width < 5 || newBox.height < 5 ? oldBox : newBox
              }
            />
          )}
        </Layer>
      </Stage>

      {editingNode && (
        <TextOverlay
          key={editingNode.id}
          node={editingNode}
          view={view}
          onCommit={(text) => {
            if (text.trim() === '') {
              canvasStore.removeNodes(project.id, [editingNode.id]);
            } else {
              canvasStore.updateNode(project.id, editingNode.id, { text } as Partial<CanvasNode>);
            }
            canvasStore.setEditing(project.id, null);
          }}
        />
      )}
    </div>
  );
});

/** Inline HTML textarea overlaid on a Text node while editing. */
const TextOverlay = ({
  node,
  view,
  onCommit,
}: {
  node: CanvasNode & { text?: string };
  view: { scale: number; x: number; y: number };
  onCommit: (text: string) => void;
}) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [val, setVal] = useState(node.text ?? '');
  useEffect(() => {
    // rAF so we win the focus race against the container taking focus on the
    // same mousedown that created this node.
    const id = requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, []);
  const fontSize = (node.style.fontSize ?? 24) * view.scale;
  return (
    <textarea
      ref={ref}
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => onCommit(val)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          onCommit(val);
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          onCommit(val);
        }
      }}
      placeholder="Type…"
      className="absolute z-50 resize-none border-0 bg-transparent p-0 outline-none"
      style={{
        left: view.x + node.x * view.scale,
        top: view.y + node.y * view.scale,
        fontSize,
        lineHeight: 1.1,
        color: node.style.stroke,
        fontFamily: node.style.fontFamily ?? 'Inter, system-ui, sans-serif',
        minWidth: 60,
        caretColor: node.style.stroke,
      }}
    />
  );
};
