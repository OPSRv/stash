/// Pure operations over the tab list. Each function takes the current
/// `Tab[]` and returns a new array — no React state, no side effects —
/// so they're unit-testable without the shell. Tree surgery lives in
/// `./paneTree.ts`; this file composes it into tab-level intents.

import {
  MAX_PANES_PER_TAB,
  type DropPosition,
  type Orientation,
  type Tab,
} from '../types';
import {
  appendLeaf,
  collectLeafIds,
  countLeaves,
  findLeafPath,
  insertBesideLeaf,
  leaf,
  ratiosAfterDrag,
  removeLeaf,
  setRatiosAt,
  swapLeaves,
} from './paneTree';
import { allLeafIds, newPaneId } from './tabStorage';

export type SplitResult = { tabs: Tab[]; newPaneId?: string };

/// Split the focused pane of `tabId` along `orientation`, creating a
/// new leaf next to it. Caps at MAX_PANES_PER_TAB leaves per tab.
export const splitPane = (
  tabs: Tab[],
  tabId: string,
  paneId: string,
  orientation: Orientation,
): SplitResult => {
  const target = tabs.find((t) => t.id === tabId);
  if (!target) return { tabs };
  if (countLeaves(target.root) >= MAX_PANES_PER_TAB) return { tabs };
  if (!findLeafPath(target.root, paneId)) return { tabs };
  const newId = newPaneId(allLeafIds(tabs));
  const zone: DropPosition = orientation === 'row' ? 'right' : 'bottom';
  const nextRoot = insertBesideLeaf(target.root, paneId, leaf(newId), zone);
  if (nextRoot === target.root) return { tabs };
  const next = tabs.map((t) => (t.id === tabId ? { ...t, root: nextRoot } : t));
  return { tabs: next, newPaneId: newId };
};

/// Convenience wrapper for `splitPane` when the caller only knows the
/// tab id (e.g. initial split where every pane of a fresh tab is the
/// first leaf). Splits against the first leaf in reading order.
export const splitTab = (
  tabs: Tab[],
  tabId: string,
  orientation: Orientation,
): SplitResult => {
  const target = tabs.find((t) => t.id === tabId);
  if (!target) return { tabs };
  const firstLeaf = collectLeafIds(target.root)[0];
  if (!firstLeaf) return { tabs };
  return splitPane(tabs, tabId, firstLeaf, orientation);
};

/// Remove a leaf from a tab. Refuses to close the sole remaining leaf
/// (shell decides how to close the tab itself).
export const closePane = (
  tabs: Tab[],
  tabId: string,
  paneId: string,
): Tab[] => {
  const target = tabs.find((t) => t.id === tabId);
  if (!target || countLeaves(target.root) < 2) return tabs;
  const nextRoot = removeLeaf(target.root, paneId);
  if (!nextRoot || nextRoot === target.root) return tabs;
  return tabs.map((t) => (t.id === tabId ? { ...t, root: nextRoot } : t));
};

/// Close an entire tab (and its panes). Returns unchanged when this is
/// the only tab — callers fall back to a "restart" action.
export const closeTab = (tabs: Tab[], tabId: string): Tab[] => {
  if (tabs.length === 1) return tabs;
  if (!tabs.some((t) => t.id === tabId)) return tabs;
  return tabs.filter((t) => t.id !== tabId);
};

/// Reorder: move `srcId` into `dstId`'s slot.
export const reorderTabs = (tabs: Tab[], srcId: string, dstId: string): Tab[] => {
  const si = tabs.findIndex((t) => t.id === srcId);
  const di = tabs.findIndex((t) => t.id === dstId);
  if (si < 0 || di < 0 || si === di) return tabs;
  const next = [...tabs];
  const [item] = next.splice(si, 1);
  next.splice(di, 0, item);
  return next;
};

export type DropResult = {
  tabs: Tab[];
  /// Tab that should become active after the drop. `null` means
  /// "don't change the active tab".
  activateTabId: string | null;
  /// Pane that should take focus. `null` means leave focus as-is.
  focusPaneId: string | null;
};

const findTabOfLeaf = (tabs: Tab[], leafId: string): Tab | undefined =>
  tabs.find((t) => findLeafPath(t.root, leafId) !== null);

/// Drop a pane onto another pane with edge-zone awareness. Handles
/// same-tab rearrangement (edge drops nest or extend splits, centre
/// swaps) and cross-tab moves.
export const dropPaneOnPane = (
  tabs: Tab[],
  sourcePaneId: string,
  destPaneId: string,
  position: DropPosition,
): DropResult => {
  const noop: DropResult = { tabs, activateTabId: null, focusPaneId: null };
  if (sourcePaneId === destPaneId) return noop;
  const srcTab = findTabOfLeaf(tabs, sourcePaneId);
  const destTab = findTabOfLeaf(tabs, destPaneId);
  if (!srcTab || !destTab) return noop;

  if (srcTab.id === destTab.id) {
    let nextRoot;
    if (position === 'center') {
      nextRoot = swapLeaves(srcTab.root, sourcePaneId, destPaneId);
    } else {
      // Pluck source, then re-insert next to dest. Works because
      // `removeLeaf` collapses / flattens so dest's path stays valid
      // as long as dest didn't ride on top of source's subtree.
      const afterRemoval = removeLeaf(srcTab.root, sourcePaneId);
      if (!afterRemoval) return noop;
      nextRoot = insertBesideLeaf(afterRemoval, destPaneId, leaf(sourcePaneId), position);
    }
    if (nextRoot === srcTab.root) return noop;
    return {
      tabs: tabs.map((t) => (t.id === srcTab.id ? { ...t, root: nextRoot } : t)),
      activateTabId: null,
      focusPaneId: sourcePaneId,
    };
  }

  // Cross-tab move — dest must have room.
  if (countLeaves(destTab.root) >= MAX_PANES_PER_TAB) return noop;

  const srcRootAfter = removeLeaf(srcTab.root, sourcePaneId);
  const destRootAfter =
    position === 'center'
      ? appendLeaf(destTab.root, leaf(sourcePaneId))
      : insertBesideLeaf(destTab.root, destPaneId, leaf(sourcePaneId), position);
  if (destRootAfter === destTab.root) return noop;

  const next: Tab[] = [];
  for (const t of tabs) {
    if (t.id === srcTab.id) {
      if (srcRootAfter === null) continue; // whole source tab disappears
      next.push({ ...t, root: srcRootAfter });
    } else if (t.id === destTab.id) {
      next.push({ ...t, root: destRootAfter });
    } else {
      next.push(t);
    }
  }
  return { tabs: next, activateTabId: destTab.id, focusPaneId: sourcePaneId };
};

/// Move a pane into a tab (tab-label drop). Appends to the destination
/// tree along its preferred axis.
export const movePaneToTab = (
  tabs: Tab[],
  paneId: string,
  destTabId: string,
): DropResult => {
  const noop: DropResult = { tabs, activateTabId: null, focusPaneId: null };
  const destTab = tabs.find((t) => t.id === destTabId);
  if (!destTab) return noop;
  const srcTab = findTabOfLeaf(tabs, paneId);
  if (!srcTab || srcTab.id === destTab.id) return noop;
  if (countLeaves(destTab.root) >= MAX_PANES_PER_TAB) return noop;

  const srcRootAfter = removeLeaf(srcTab.root, paneId);
  const destRootAfter = appendLeaf(destTab.root, leaf(paneId));
  const next: Tab[] = [];
  for (const t of tabs) {
    if (t.id === srcTab.id) {
      if (srcRootAfter === null) continue;
      next.push({ ...t, root: srcRootAfter });
    } else if (t.id === destTab.id) {
      next.push({ ...t, root: destRootAfter });
    } else {
      next.push(t);
    }
  }
  return { tabs: next, activateTabId: destTab.id, focusPaneId: paneId };
};

/// Rewrite ratios of the split node at `path` inside `tabId`.
/// `absolutePct` is the splitter's position as 0..100 of the split's
/// extent; `splitterIdx` is the index of the boundary between siblings
/// `splitterIdx` and `splitterIdx + 1`.
export const applyRatioDrag = (
  tabs: Tab[],
  tabId: string,
  path: number[],
  splitterIdx: number,
  absolutePct: number,
): Tab[] => {
  const target = tabs.find((t) => t.id === tabId);
  if (!target) return tabs;
  const node = path.reduce<import('../types').PaneNode | null>(
    (acc, idx) => (acc && acc.kind === 'split' ? acc.children[idx] ?? null : null),
    target.root,
  );
  if (!node || node.kind !== 'split') return tabs;
  const nextRatios = ratiosAfterDrag(node.ratios, splitterIdx, absolutePct);
  if (nextRatios === node.ratios) return tabs;
  const nextRoot = setRatiosAt(target.root, path, nextRatios);
  if (nextRoot === target.root) return tabs;
  return tabs.map((t) => (t.id === tabId ? { ...t, root: nextRoot } : t));
};
