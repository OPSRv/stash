import React from 'react';

import {
  MAX_PANES_PER_TAB,
  type Orientation,
  type PaneNode,
  type Tab,
} from './types';
import { collectLeafIds, countLeaves } from './state/paneTree';
import { TerminalPane } from './TerminalPane';
import { Splitter } from './ui/Splitter';

export type TabContentProps = {
  tab: Tab;
  visible: boolean;
  focusedPane: string;
  setFocusedPane: (id: string) => void;
  /// Split a specific pane along `orientation`, creating a new leaf
  /// adjacent to it. The shell validates the leaf cap before acting.
  onSplit: (paneId: string, orientation: Orientation) => void;
  onClosePane: (paneId: string) => void;
  /// Commit a splitter drag: rewrite ratios of the split at `path`,
  /// shifting the boundary between sibling `index` and `index + 1` to
  /// `absolutePct` of the split's extent.
  onRatios: (path: number[], index: number, absolutePct: number) => void;
  /// Pointer-down factory from the shell's drag manager. Called per
  /// pane during render.
  onPaneDragStart: (
    paneId: string,
    label: string,
  ) => (e: React.PointerEvent) => void;
  /// Bumped by the shell on every layout change so the child panes
  /// can re-fit and fire SIGWINCH to alt-screen TUIs.
  revision: number;
};

/// Renders a tab's pane tree. Each Split node becomes a flex container
/// with child wrappers interleaved with `Splitter`s; nesting lets users
/// compose arbitrary tiling layouts (2×2, L-shape, side-rail etc.) by
/// dragging panes onto each other's edge zones.
export const TabContent = ({
  tab,
  visible,
  focusedPane,
  setFocusedPane,
  onSplit,
  onClosePane,
  onRatios,
  onPaneDragStart,
  revision,
}: TabContentProps) => {
  const leafCount = countLeaves(tab.root);
  const canSplit = leafCount < MAX_PANES_PER_TAB;
  const isSplit = leafCount > 1;

  const render = (node: PaneNode, path: number[]): React.ReactNode => {
    if (node.kind === 'leaf') {
      return (
        <TerminalPane
          id={node.id}
          visible={visible}
          active={focusedPane === node.id}
          onFocus={() => setFocusedPane(node.id)}
          layoutRevision={revision}
          onSplit={
            canSplit ? (orientation) => onSplit(node.id, orientation) : undefined
          }
          onClosePane={isSplit ? () => onClosePane(node.id) : undefined}
          onPaneDragStart={onPaneDragStart(node.id, `Pane ${node.id}`)}
        />
      );
    }

    const items: React.ReactNode[] = [];
    for (let i = 0; i < node.children.length; i++) {
      const childPath = [...path, i];
      const leafIdsInChild = collectLeafIds(node.children[i]).join('-');
      items.push(
        <div
          key={`c-${i}-${leafIdsInChild}`}
          style={{
            // Ratio-driven weighted growth. `flex-grow: ratio` plus
            // `flex-basis: 0` means the splitters (fixed 4px) take their
            // exact space first and children divide the remainder
            // proportionally — so ratios don't drift as splitters appear.
            flex: `${node.ratios[i]} 1 0`,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            minHeight: 0,
          }}
        >
          {render(node.children[i], childPath)}
        </div>,
      );
      if (i < node.children.length - 1) {
        items.push(
          <Splitter
            key={`s-${i}`}
            orientation={node.orientation}
            onDrag={(pct) => onRatios(path, i, pct)}
          />,
        );
      }
    }

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: node.orientation,
          flex: 1,
          minWidth: 0,
          minHeight: 0,
        }}
      >
        {items}
      </div>
    );
  };

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: visible ? 'flex' : 'none',
        flexDirection: 'row',
      }}
    >
      {render(tab.root, [])}
    </div>
  );
};
