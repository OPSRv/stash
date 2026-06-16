// Canvas scene model. One project == one editor tab. The scene is a flat,
// z-ordered list of nodes (bottom-most first); each node is also a row in the
// Layers panel — the same "every object is a layer" model the macOS Annotate
// app uses. Raster bytes never live in this struct: image nodes carry an
// `assetId` (persisted on disk) and a transient `src` data-URL for rendering.

export type ToolKind =
  | 'select'
  | 'rect'
  | 'oval'
  | 'line'
  | 'arrow'
  | 'freehand'
  | 'text'
  | 'highlighter'
  | 'counter'
  | 'blur'
  | 'erase'
  | 'eraser';

/** Actions that fire once rather than staying selected as the active tool. */
export type ActionKind = 'paste' | 'copyVisible';

export interface NodeStyle {
  /** Stroke / line colour (hex). */
  stroke: string;
  strokeWidth: number;
  /** Fill colour (hex) or 'transparent'. */
  fill: string;
  /** 0..1 overall node opacity. */
  opacity: number;
  /** Dashed outline for shapes / lines. */
  dashed?: boolean;
  /** Corner radius for rectangles. */
  radius?: number;
  /** Arrowhead at the end (Arrow tool). */
  arrowHead?: boolean;
  fontSize?: number;
  fontFamily?: string;
  /** Blur / pixelate strength for the blur tool. */
  blur?: number;
}

export interface BaseNode {
  id: string;
  tool: ToolKind | 'image';
  name: string;
  visible: boolean;
  locked: boolean;
  /** Top-left anchor of the node in stage coordinates. */
  x: number;
  y: number;
  rotation: number;
  style: NodeStyle;
}

export interface ImageNode extends BaseNode {
  tool: 'image';
  assetId: string | null;
  /** Transient data-URL for rendering before/without disk persistence. */
  src: string;
  width: number;
  height: number;
}

export interface RectNode extends BaseNode {
  tool: 'rect' | 'highlighter' | 'blur' | 'erase';
  width: number;
  height: number;
}

export interface OvalNode extends BaseNode {
  tool: 'oval';
  width: number;
  height: number;
}

/** Line & Arrow: points are stored relative to (x, y), flattened [x0,y0,x1,y1,…]. */
export interface LineNode extends BaseNode {
  tool: 'line' | 'arrow';
  points: number[];
}

export interface FreehandNode extends BaseNode {
  tool: 'freehand' | 'eraser';
  points: number[];
}

export interface TextNode extends BaseNode {
  tool: 'text';
  text: string;
  width: number;
}

export interface CounterNode extends BaseNode {
  tool: 'counter';
  value: number;
  radius: number;
}

export type CanvasNode =
  | ImageNode
  | RectNode
  | OvalNode
  | LineNode
  | FreehandNode
  | TextNode
  | CounterNode;

export type BackdropFill =
  | { kind: 'solid'; color: string }
  | { kind: 'gradient'; from: string; to: string; angle: number };

export interface Backdrop {
  enabled: boolean;
  padding: number;
  radius: number;
  border: number;
  borderColor: string;
  fill: BackdropFill;
  /** Id of the applied preset, or null when fully custom. */
  preset: string | null;
}

export interface CanvasProject {
  id: string;
  title: string;
  width: number;
  height: number;
  backdrop: Backdrop;
  nodes: CanvasNode[];
  createdAt: number;
  updatedAt: number;
}

/** Short unique id with a readable prefix. */
export const nid = (prefix = 'n'): string => {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(36).slice(2);
  return `${prefix}_${raw.slice(0, 12)}`;
};

export const DEFAULT_STYLE: NodeStyle = {
  stroke: '#ff3b30',
  strokeWidth: 3,
  fill: 'transparent',
  opacity: 1,
  dashed: false,
  radius: 6,
  arrowHead: true,
  fontSize: 24,
  fontFamily: 'Inter, system-ui, sans-serif',
  blur: 12,
};

export const defaultBackdrop = (): Backdrop => ({
  enabled: false,
  padding: 64,
  radius: 16,
  border: 0,
  borderColor: '#ffffff',
  fill: { kind: 'gradient', from: '#6366f1', to: '#ec4899', angle: 135 },
  preset: 'indigo-pink',
});
