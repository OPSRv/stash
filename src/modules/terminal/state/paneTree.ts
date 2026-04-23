/// Pure tree operations over `PaneNode`. All functions are immutable —
/// they return a new subtree or `null` (for whole-tree removal). These
/// are the building blocks consumed by `tabOps.ts`; keeping them
/// narrowly focused + unit-testable means the higher-level tab logic
/// stays small.

import {
  MIN_PANE_PCT,
  type DropPosition,
  type Orientation,
  type PaneLeaf,
  type PaneNode,
  type PaneSplit,
} from '../types';

export const leaf = (id: string): PaneLeaf => ({ kind: 'leaf', id });

export const isLeaf = (n: PaneNode): n is PaneLeaf => n.kind === 'leaf';
export const isSplit = (n: PaneNode): n is PaneSplit => n.kind === 'split';

export const collectLeafIds = (n: PaneNode): string[] =>
  isLeaf(n) ? [n.id] : n.children.flatMap(collectLeafIds);

export const countLeaves = (n: PaneNode): number =>
  isLeaf(n) ? 1 : n.children.reduce((s, c) => s + countLeaves(c), 0);

const equalRatios = (n: number): number[] => Array(n).fill(100 / n);

const normalizeRatios = (rs: number[]): number[] => {
  const sum = rs.reduce((a, b) => a + b, 0);
  if (sum <= 0) return equalRatios(rs.length);
  return rs.map((r) => (r / sum) * 100);
};

/// Build a fresh Split node with `children`. Collapses single-child
/// splits into the child, and flattens adjacent same-orientation
/// splits into the parent so the tree stays canonical (shallow).
const makeSplit = (
  orientation: Orientation,
  children: PaneNode[],
  ratios?: number[],
): PaneNode => {
  if (children.length === 0) throw new Error('split with no children');
  if (children.length === 1) return children[0];
  // Flatten consecutive splits of the same orientation into this one.
  const flatKids: PaneNode[] = [];
  const flatRatios: number[] = [];
  const baseRatios = ratios && ratios.length === children.length ? ratios : equalRatios(children.length);
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    const r = baseRatios[i];
    if (isSplit(c) && c.orientation === orientation) {
      // Distribute parent share across inner ratios.
      for (let j = 0; j < c.children.length; j++) {
        flatKids.push(c.children[j]);
        flatRatios.push((c.ratios[j] / 100) * r);
      }
    } else {
      flatKids.push(c);
      flatRatios.push(r);
    }
  }
  return {
    kind: 'split',
    orientation,
    children: flatKids,
    ratios: normalizeRatios(flatRatios),
  };
};

/// Return the indices path from `root` down to the leaf with `id`, or
/// null when no such leaf exists. Empty path means the root itself is
/// the matching leaf.
export const findLeafPath = (
  root: PaneNode,
  id: string,
  path: number[] = [],
): number[] | null => {
  if (isLeaf(root)) return root.id === id ? path : null;
  for (let i = 0; i < root.children.length; i++) {
    const p = findLeafPath(root.children[i], id, [...path, i]);
    if (p) return p;
  }
  return null;
};

export const nodeAt = (root: PaneNode, path: number[]): PaneNode => {
  let cur: PaneNode = root;
  for (const i of path) {
    if (isLeaf(cur)) break;
    cur = cur.children[i];
  }
  return cur;
};

/// Replace the subtree at `path` with `replacement`. Empty path swaps
/// the whole root. Invalid paths (indexing into a leaf) return `root`
/// unchanged so callers don't need to pre-validate.
const replaceAt = (
  root: PaneNode,
  path: number[],
  replacement: PaneNode,
): PaneNode => {
  if (path.length === 0) return replacement;
  if (isLeaf(root)) return root;
  const [idx, ...rest] = path;
  if (idx < 0 || idx >= root.children.length) return root;
  const children = [...root.children];
  children[idx] = replaceAt(children[idx], rest, replacement);
  return makeSplit(root.orientation, children, root.ratios);
};

/// Remove the leaf with `id`. Returns the pruned tree, or `null` when
/// the whole tree was just that leaf. Sibling ratios are redistributed
/// proportionally; a split that drops to one child collapses into it.
export const removeLeaf = (n: PaneNode, id: string): PaneNode | null => {
  if (isLeaf(n)) return n.id === id ? null : n;
  const keptChildren: PaneNode[] = [];
  const keptRatios: number[] = [];
  let changed = false;
  for (let i = 0; i < n.children.length; i++) {
    const sub = removeLeaf(n.children[i], id);
    if (sub === null) {
      changed = true;
      continue;
    }
    keptChildren.push(sub);
    keptRatios.push(n.ratios[i]);
    if (sub !== n.children[i]) changed = true;
  }
  if (!changed) return n;
  if (keptChildren.length === 0) return null;
  if (keptChildren.length === 1) return keptChildren[0];
  return makeSplit(n.orientation, keptChildren, normalizeRatios(keptRatios));
};

/// Insert `newLeaf` adjacent to the leaf with `targetId` at the given
/// edge `zone`. `center` is rejected here — callers (drop logic) handle
/// centre as a swap instead. If the existing parent has the matching
/// orientation, extend it; otherwise nest target + newLeaf inside a
/// new split of the requested orientation.
export const insertBesideLeaf = (
  root: PaneNode,
  targetId: string,
  newLeaf: PaneLeaf,
  zone: Exclude<DropPosition, 'center'>,
): PaneNode => {
  const path = findLeafPath(root, targetId);
  if (!path) return root;
  const orientation: Orientation = zone === 'top' || zone === 'bottom' ? 'column' : 'row';
  const before = zone === 'left' || zone === 'top';

  // Target is the root leaf — wrap both in a new split.
  if (path.length === 0 && isLeaf(root)) {
    const children = before ? [newLeaf, root] : [root, newLeaf];
    return makeSplit(orientation, children, [50, 50]);
  }

  const parentPath = path.slice(0, -1);
  const parent = nodeAt(root, parentPath);
  if (!isSplit(parent)) return root;
  const idxInParent = path[path.length - 1];

  if (parent.orientation === orientation) {
    // Extend parent: insert new leaf adjacent to target, splitting the
    // target's current share between target and newLeaf (so the rest
    // of the siblings keep their exact widths).
    const insertAt = before ? idxInParent : idxInParent + 1;
    const children = [...parent.children];
    children.splice(insertAt, 0, newLeaf);
    const ratios = [...parent.ratios];
    const half = ratios[idxInParent] / 2;
    ratios[idxInParent] = half;
    ratios.splice(insertAt, 0, half);
    const nextParent = makeSplit(parent.orientation, children, ratios);
    return replaceAt(root, parentPath, nextParent);
  }

  // Nest: replace target leaf with a perpendicular split of target +
  // newLeaf at 50/50, preserving the target's outer share.
  const target = parent.children[idxInParent];
  const nestedChildren = before ? [newLeaf, target] : [target, newLeaf];
  const nested = makeSplit(orientation, nestedChildren, [50, 50]);
  return replaceAt(root, path, nested);
};

/// Swap the two named leaves. No-op when either id is missing or they
/// point at the same leaf. Used by centre-zone drops (which mean
/// "move me here, push the resident aside").
export const swapLeaves = (
  root: PaneNode,
  a: string,
  b: string,
): PaneNode => {
  if (a === b) return root;
  const pa = findLeafPath(root, a);
  const pb = findLeafPath(root, b);
  if (!pa || !pb) return root;
  const la = nodeAt(root, pa);
  const lb = nodeAt(root, pb);
  if (!isLeaf(la) || !isLeaf(lb)) return root;
  return replaceAt(replaceAt(root, pa, lb), pb, la);
};

/// Append `newLeaf` at the end of the root along its preferred axis.
/// Used for tab-label drops and cross-tab moves without an explicit
/// destination pane.
export const appendLeaf = (root: PaneNode, newLeaf: PaneLeaf): PaneNode => {
  if (isLeaf(root)) return makeSplit('row', [root, newLeaf], [50, 50]);
  const children = [...root.children, newLeaf];
  const ratios = [
    ...root.ratios.map((r) => r * (children.length - 1) / children.length),
    100 / children.length,
  ];
  return makeSplit(root.orientation, children, normalizeRatios(ratios));
};

/// Replace the ratios of the split at `path`. Returns the root
/// unchanged when the path points elsewhere or when `ratios` has the
/// wrong length. Callers compute new ratios based on a splitter drag.
export const setRatiosAt = (
  root: PaneNode,
  path: number[],
  ratios: number[],
): PaneNode => {
  const node = nodeAt(root, path);
  if (!isSplit(node) || ratios.length !== node.children.length) return root;
  const next: PaneSplit = {
    kind: 'split',
    orientation: node.orientation,
    children: node.children,
    ratios: normalizeRatios(ratios),
  };
  return replaceAt(root, path, next);
};

/// Produce new ratios for the pair of siblings at indices `idx` and
/// `idx+1` inside a split node with `ratios`. `absolutePct` is the
/// splitter pointer position expressed as a 0..100 percent of the
/// split node's full extent. Clamped so neither sibling of the pair
/// drops below MIN_PANE_PCT.
export const ratiosAfterDrag = (
  ratios: number[],
  idx: number,
  absolutePct: number,
): number[] => {
  if (idx < 0 || idx >= ratios.length - 1) return ratios;
  const before = ratios.slice(0, idx).reduce((a, b) => a + b, 0);
  const combined = ratios[idx] + ratios[idx + 1];
  const min = Math.min(MIN_PANE_PCT, combined / 2);
  const newFirst = Math.max(min, Math.min(combined - min, absolutePct - before));
  const next = [...ratios];
  next[idx] = newFirst;
  next[idx + 1] = combined - newFirst;
  return next;
};

/// Structural validity check for persisted / incoming tree data.
export const isValidNode = (n: unknown): n is PaneNode => {
  if (!n || typeof n !== 'object') return false;
  const node = n as { kind?: unknown };
  if (node.kind === 'leaf') {
    return typeof (node as PaneLeaf).id === 'string';
  }
  if (node.kind === 'split') {
    const s = node as Partial<PaneSplit>;
    if (s.orientation !== 'row' && s.orientation !== 'column') return false;
    if (!Array.isArray(s.ratios) || !Array.isArray(s.children)) return false;
    if (s.children.length < 2) return false;
    if (s.ratios.length !== s.children.length) return false;
    if (!s.ratios.every((r) => typeof r === 'number' && Number.isFinite(r))) return false;
    return s.children.every(isValidNode);
  }
  return false;
};
