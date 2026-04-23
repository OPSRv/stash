/// Shared types for the terminal module. Split out so presentational
/// components and state helpers can import them without pulling in the
/// entire shell.

export type Orientation = 'row' | 'column';

/// Recursive layout tree. Each leaf is one PTY-backed pane; each split
/// node arranges its children along a single axis with ratios summing
/// to 100. Arbitrary nesting → 2×2, L-shapes, side-rail-plus-stack,
/// whatever the user composes by dragging.
export type PaneLeaf = { kind: 'leaf'; id: string };
export type PaneSplit = {
  kind: 'split';
  orientation: Orientation;
  /// Length === children.length; sum === 100. Each entry is the percent
  /// share along `orientation`. Splitter drags rewrite two adjacent
  /// entries (keeping their sum constant) and leave the rest untouched.
  ratios: number[];
  /// At least two children; a single-child split collapses during
  /// `removeLeaf` / mutation to keep the tree canonical.
  children: PaneNode[];
};
export type PaneNode = PaneLeaf | PaneSplit;

/// One tab = one workspace. Holds a recursive pane tree (root is either
/// a single leaf or a nested split). `label` is the user-renamed tab
/// title; `undefined` falls back to a default derived from the tab id.
export type Tab = {
  id: string;
  root: PaneNode;
  label?: string;
};

export const MAX_TABS = 8;
export const MAX_PANES_PER_TAB = 4;
/// Minimum absolute percent a single pane can shrink to during a
/// splitter drag — below this it becomes unrecoverable without a drop.
export const MIN_PANE_PCT = 10;

/// Five drop zones around a pane. `center` is a move/swap; the four
/// edges split along that side. Tab-label drops always resolve to
/// `center` (they mean "move into this tab").
export type DropPosition = 'left' | 'right' | 'top' | 'bottom' | 'center';

/// Source of a pointer drag. Encodes the kind in the string itself
/// (e.g. `pane:pane-2`) so a single drag-state field can describe
/// every gesture the shell supports.
export type DragSource = `tab:${string}` | `pane:${string}`;

export type DragState = {
  source: DragSource;
  x: number;
  y: number;
  target: string | null;
  zone: DropPosition;
  label: string;
};

export type ContextMenuAction =
  | 'copy'
  | 'copy-all'
  | 'paste'
  | 'clear'
  | 'find'
  | 'compose'
  | 'split-right'
  | 'split-down'
  | 'maximize'
  | 'restart'
  | 'close-pane';
