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
  /// `sourceCwd` is the live cwd of the pane requesting the split so
  /// the new sibling's PTY can spawn in the same directory.
  onSplit: (paneId: string, orientation: Orientation, sourceCwd: string) => void;
  /// Returns the seed cwd for a pane id (set by the shell when the
  /// pane was created via split), or undefined for panes restored
  /// from persisted state.
  getInitialCwd: (paneId: string) => string | undefined;
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
  /// Leaf id currently maximized inside this tab (null → normal tiling).
  /// Siblings stay mounted so their PTY/xterm state survives the zoom.
  maximizedPane: string | null;
  /// Enter/exit zoom from a pane's context menu.
  onToggleMaximize: (paneId: string) => void;
  /// Bumped by the shell on every layout change so the child panes
  /// can re-fit and fire SIGWINCH to alt-screen TUIs.
  revision: number;
  /// xterm font size for every pane, driven by the shell's
  /// ⌘+/⌘−/⌘0 shortcuts.
  fontSize: number;
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
  maximizedPane,
  onToggleMaximize,
  revision,
  getInitialCwd,
  fontSize,
}: TabContentProps) => {
  const leafCount = countLeaves(tab.root);
  const canSplit = leafCount < MAX_PANES_PER_TAB;
  const isSplit = leafCount > 1;

  const render = (node: PaneNode, path: number[]): React.ReactNode => {
    if (node.kind === 'leaf') {
      const isMaximized = maximizedPane === node.id;
      return (
        <TerminalPane
          id={node.id}
          visible={visible}
          active={focusedPane === node.id}
          onFocus={() => setFocusedPane(node.id)}
          layoutRevision={revision}
          onSplit={
            canSplit
              ? (orientation, sourceCwd) =>
                  onSplit(node.id, orientation, sourceCwd)
              : undefined
          }
          onClosePane={isSplit ? () => onClosePane(node.id) : undefined}
          onPaneDragStart={onPaneDragStart(node.id, `Pane ${node.id}`)}
          onToggleMaximize={isSplit ? () => onToggleMaximize(node.id) : undefined}
          maximized={isMaximized}
          initialCwd={getInitialCwd(node.id)}
          fontSize={fontSize}
        />
      );
    }

    const items: React.ReactNode[] = [];
    const maximizedLiveInChild = node.children.map((c) =>
      maximizedPane ? collectLeafIds(c).includes(maximizedPane) : false,
    );
    for (let i = 0; i < node.children.length; i++) {
      const childPath = [...path, i];
      const leafIdsInChild = collectLeafIds(node.children[i]).join('-');
      const hostsMaximized = maximizedLiveInChild[i];
      // When the zoom target lives in this subtree, its wrapper takes
      // full size via absolute overlay so the rest of the layout can
      // relax — siblings stay mounted underneath but their sizes are
      // whatever the flex fallback gives (xterm ignores hidden hosts
      // via ResizeObserver anyway).
      const style: React.CSSProperties = hostsMaximized
        ? {
            position: 'absolute',
            inset: 0,
            zIndex: 20,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            minHeight: 0,
          }
        : {
            flex: `${node.ratios[i]} 1 0`,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            minHeight: 0,
          };
      items.push(
        <div key={`c-${i}-${leafIdsInChild}`} style={style}>
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
          position: 'relative',
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
