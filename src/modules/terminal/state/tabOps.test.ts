import { describe, expect, it } from 'vitest';

import {
  applyRatioDrag,
  closePane,
  closeTab,
  dropPaneOnPane,
  movePaneToTab,
  reorderTabs,
  splitPane,
  splitTab,
} from './tabOps';
import { collectLeafIds, countLeaves, findLeafPath, leaf, nodeAt } from './paneTree';
import type { PaneNode, Tab } from '../types';

/// Small factories. Keep the tree shape inline so each test reads as a
/// self-contained spec of "this layout → that layout".
const t = (id: string, root: PaneNode, label?: string): Tab => ({ id, root, label });
const split = (
  orientation: 'row' | 'column',
  children: PaneNode[],
  ratios?: number[],
): PaneNode => ({
  kind: 'split',
  orientation,
  ratios: ratios ?? children.map(() => 100 / children.length),
  children,
});

describe('tabOps / splitPane', () => {
  it('creates a sibling leaf next to a single-leaf tab', () => {
    const { tabs, newPaneId } = splitPane(
      [t('tab-1', leaf('pane-1'))],
      'tab-1',
      'pane-1',
      'row',
    );
    expect(newPaneId).toBe('pane-2');
    expect(collectLeafIds(tabs[0].root)).toEqual(['pane-1', 'pane-2']);
    const root = tabs[0].root;
    expect(root.kind).toBe('split');
    if (root.kind === 'split') expect(root.orientation).toBe('row');
  });

  it('nests a perpendicular split under the focused pane', () => {
    const start: PaneNode = split('row', [leaf('pane-1'), leaf('pane-2')]);
    const { tabs, newPaneId } = splitPane(
      [t('tab-1', start)],
      'tab-1',
      'pane-2',
      'column',
    );
    expect(newPaneId).toBe('pane-3');
    // Root still row; p2 is now a column-split of [p2, p3].
    const root = tabs[0].root;
    expect(root.kind).toBe('split');
    if (root.kind === 'split') {
      expect(root.orientation).toBe('row');
      expect(root.children[0]).toEqual(leaf('pane-1'));
      const inner = root.children[1];
      expect(inner.kind).toBe('split');
      if (inner.kind === 'split') {
        expect(inner.orientation).toBe('column');
        expect(inner.children.map(collectLeafIds)).toEqual([['pane-2'], ['pane-3']]);
      }
    }
  });

  it('builds a 2×2 via three drag-equivalent splits', () => {
    // Start: p1. Add right → row[p1,p2]. Split p1 bottom → row[col[p1,p3], p2].
    // Split p2 bottom → row[col[p1,p3], col[p2,p4]].
    let tabs: Tab[] = [t('tab-1', leaf('pane-1'))];
    tabs = splitPane(tabs, 'tab-1', 'pane-1', 'row').tabs;
    tabs = splitPane(tabs, 'tab-1', 'pane-1', 'column').tabs;
    tabs = splitPane(tabs, 'tab-1', 'pane-2', 'column').tabs;
    expect(countLeaves(tabs[0].root)).toBe(4);
    const root = tabs[0].root;
    expect(root.kind).toBe('split');
    if (root.kind === 'split') {
      expect(root.orientation).toBe('row');
      expect(root.children.length).toBe(2);
      for (const col of root.children) {
        expect(col.kind).toBe('split');
        if (col.kind === 'split') expect(col.orientation).toBe('column');
      }
    }
  });

  it('is a no-op at the leaf cap', () => {
    const full = t(
      'tab-1',
      split('row', [leaf('pane-1'), leaf('pane-2'), leaf('pane-3'), leaf('pane-4')]),
    );
    const res = splitPane([full], 'tab-1', 'pane-1', 'row');
    expect(res.tabs).toEqual([full]);
    expect(res.newPaneId).toBeUndefined();
  });
});

describe('tabOps / splitTab', () => {
  it('splits against the first leaf in reading order', () => {
    const { tabs, newPaneId } = splitTab(
      [t('tab-1', split('row', [leaf('pane-1'), leaf('pane-2')]))],
      'tab-1',
      'column',
    );
    expect(newPaneId).toBe('pane-3');
    // p1 gets nested into a column-split.
    const root = tabs[0].root;
    if (root.kind === 'split') {
      const first = root.children[0];
      expect(first.kind).toBe('split');
      if (first.kind === 'split') expect(first.orientation).toBe('column');
    }
  });
});

describe('tabOps / closePane', () => {
  it('collapses a two-leaf tab back to a single leaf', () => {
    const res = closePane(
      [t('tab-1', split('row', [leaf('pane-1'), leaf('pane-2')]))],
      'tab-1',
      'pane-2',
    );
    expect(res[0].root).toEqual(leaf('pane-1'));
  });

  it('keeps nested shape when removing one of many leaves', () => {
    const tree: PaneNode = split('row', [
      split('column', [leaf('pane-1'), leaf('pane-3')]),
      leaf('pane-2'),
    ]);
    const res = closePane([t('tab-1', tree)], 'tab-1', 'pane-3');
    // Nested column split collapses into its sole survivor p1,
    // which then flattens back to a row of [p1, p2].
    expect(collectLeafIds(res[0].root)).toEqual(['pane-1', 'pane-2']);
  });

  it('refuses to close the sole pane of a tab', () => {
    const input = [t('tab-1', leaf('pane-1'))];
    expect(closePane(input, 'tab-1', 'pane-1')).toBe(input);
  });
});

describe('tabOps / closeTab', () => {
  it('removes the tab when more than one exists', () => {
    const res = closeTab(
      [t('tab-1', leaf('pane-1')), t('tab-2', leaf('pane-2'))],
      'tab-1',
    );
    expect(res.map((x) => x.id)).toEqual(['tab-2']);
  });

  it('keeps the only tab alive', () => {
    const input = [t('tab-1', leaf('pane-1'))];
    expect(closeTab(input, 'tab-1')).toBe(input);
  });
});

describe('tabOps / reorderTabs', () => {
  it('moves src into dst slot', () => {
    const res = reorderTabs(
      [t('tab-1', leaf('pane-1')), t('tab-2', leaf('pane-2')), t('tab-3', leaf('pane-3'))],
      'tab-1',
      'tab-3',
    );
    expect(res.map((x) => x.id)).toEqual(['tab-2', 'tab-3', 'tab-1']);
  });
});

describe('tabOps / dropPaneOnPane', () => {
  it('swaps panes on centre drop within the same tab', () => {
    const tree: PaneNode = split('row', [leaf('pane-1'), leaf('pane-2')]);
    const res = dropPaneOnPane([t('tab-1', tree)], 'pane-2', 'pane-1', 'center');
    expect(collectLeafIds(res.tabs[0].root)).toEqual(['pane-2', 'pane-1']);
    expect(res.focusPaneId).toBe('pane-2');
    expect(res.activateTabId).toBeNull();
  });

  it('nests perpendicular split on bottom drop within same tab', () => {
    const tree: PaneNode = split('row', [leaf('pane-1'), leaf('pane-2')]);
    const res = dropPaneOnPane([t('tab-1', tree)], 'pane-1', 'pane-2', 'bottom');
    // p1 plucked from the row, then inserted below p2 → row[col[p2, p1]]
    // which collapses to column[p2, p1] after the single-child row
    // collapses in `removeLeaf` (`afterRemoval` = leaf('pane-2')).
    const root = res.tabs[0].root;
    expect(root.kind).toBe('split');
    if (root.kind === 'split') {
      expect(root.orientation).toBe('column');
      expect(collectLeafIds(root)).toEqual(['pane-2', 'pane-1']);
    }
  });

  it('moves pane across tabs and drops empty source tab', () => {
    const res = dropPaneOnPane(
      [t('tab-1', leaf('pane-1')), t('tab-2', leaf('pane-2'))],
      'pane-1',
      'pane-2',
      'bottom',
    );
    expect(res.tabs.map((x) => x.id)).toEqual(['tab-2']);
    expect(res.activateTabId).toBe('tab-2');
    expect(res.focusPaneId).toBe('pane-1');
    const root = res.tabs[0].root;
    if (root.kind === 'split') {
      expect(root.orientation).toBe('column');
      expect(collectLeafIds(root)).toEqual(['pane-2', 'pane-1']);
    }
  });

  it('rejects cross-tab drop when destination is at the cap', () => {
    const full = [
      t('tab-1', leaf('pane-5')),
      t('tab-2', split('row', [leaf('pane-1'), leaf('pane-2'), leaf('pane-3'), leaf('pane-4')])),
    ];
    const res = dropPaneOnPane(full, 'pane-5', 'pane-2', 'right');
    expect(res.tabs).toBe(full);
  });
});

describe('tabOps / movePaneToTab', () => {
  it('appends the pane to the destination root', () => {
    const res = movePaneToTab(
      [t('tab-1', leaf('pane-1')), t('tab-2', leaf('pane-2'))],
      'pane-1',
      'tab-2',
    );
    expect(res.tabs.map((x) => x.id)).toEqual(['tab-2']);
    expect(collectLeafIds(res.tabs[0].root)).toEqual(['pane-2', 'pane-1']);
    expect(res.activateTabId).toBe('tab-2');
  });

  it('is a no-op when destination and source tab are the same', () => {
    const input = [t('tab-1', split('row', [leaf('pane-1'), leaf('pane-2')]))];
    const res = movePaneToTab(input, 'pane-1', 'tab-1');
    expect(res.tabs).toBe(input);
  });
});

describe('tabOps / applyRatioDrag', () => {
  it('rewrites the targeted split boundary without touching others', () => {
    const tree: PaneNode = split(
      'row',
      [leaf('pane-1'), leaf('pane-2'), leaf('pane-3')],
      [40, 30, 30],
    );
    const next = applyRatioDrag([t('tab-1', tree)], 'tab-1', [], 0, 20);
    // Dragged boundary 0↔1 to 20 % of the row.
    const root = next[0].root;
    if (root.kind === 'split') {
      expect(root.ratios[0]).toBeCloseTo(20, 1);
      expect(root.ratios[1]).toBeCloseTo(50, 1); // 40+30 - 20 = 50
      expect(root.ratios[2]).toBeCloseTo(30, 1);
    }
  });

  it('clamps to MIN_PANE_PCT so panes never vanish', () => {
    const tree: PaneNode = split('row', [leaf('pane-1'), leaf('pane-2')], [50, 50]);
    const next = applyRatioDrag([t('tab-1', tree)], 'tab-1', [], 0, 2);
    const root = next[0].root;
    if (root.kind === 'split') {
      expect(root.ratios[0]).toBeGreaterThanOrEqual(10);
      expect(root.ratios[0] + root.ratios[1]).toBeCloseTo(100, 3);
    }
  });
});

describe('paneTree / path helpers', () => {
  it('findLeafPath + nodeAt round-trip', () => {
    const tree: PaneNode = split('row', [
      split('column', [leaf('pane-1'), leaf('pane-3')]),
      leaf('pane-2'),
    ]);
    const path = findLeafPath(tree, 'pane-3');
    expect(path).toEqual([0, 1]);
    expect(nodeAt(tree, path!)).toEqual(leaf('pane-3'));
  });
});
