import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { ptyClose } from './api';
import { useDrag } from './hooks/useDrag';
import {
  allLeafIds,
  loadStoredActive,
  loadStoredTabs,
  newPaneId,
  newTabId,
  saveTabs,
  tabLabel,
} from './state/tabStorage';
import {
  applyRatioDrag,
  closePane as closePaneOp,
  closeTab as closeTabOp,
  dropPaneOnPane,
  movePaneToTab,
  reorderTabs,
  splitPane as splitPaneOp,
} from './state/tabOps';
import { collectLeafIds, countLeaves, leaf } from './state/paneTree';
import {
  MAX_PANES_PER_TAB,
  MAX_TABS,
  type DropPosition,
  type Orientation,
  type Tab,
} from './types';
import { TabContent } from './TabContent';
import { DragGhost } from './ui/DragGhost';
import { TabBar } from './ui/TabBar';

/// Public terminal entrypoint. Thin orchestrator: owns the tab state,
/// persistence, drag manager, keyboard shortcuts, and popup-auto-hide
/// suppression. All rendering (tab bar, pane bodies, compose strip) is
/// delegated to split-out components under `./ui/` and `./TerminalPane`.
export const TerminalShell = () => {
  const [tabs, setTabs] = useState<Tab[]>(loadStoredTabs);
  const [activeId, setActiveId] = useState<string>(() =>
    loadStoredActive(loadStoredTabs()[0]?.id ?? 'tab-1'),
  );
  const [focusedPane, setFocusedPane] = useState<string>(() => {
    const first = loadStoredTabs()[0];
    return first ? collectLeafIds(first.root)[0] : 'pane-1';
  });
  const [revision, setRevision] = useState(0);
  const bumpRevision = useCallback(() => setRevision((n) => n + 1), []);
  /// Leaf id that temporarily takes over the whole tab (hides its
  /// siblings via a full-cover overlay). Null → normal tiling. Toggled
  /// by `⌘E` and by the pane context menu's "Maximize" item. Clears
  /// automatically when the maximized leaf no longer exists in the
  /// active tab (close, drag across tabs).
  const [maximizedPane, setMaximizedPane] = useState<string | null>(null);
  const maximizedPaneRef = useRef(maximizedPane);
  useEffect(() => {
    maximizedPaneRef.current = maximizedPane;
  }, [maximizedPane]);

  // Refs kept in sync with state so the document-level keyboard
  // listener (bound once on mount) always sees current values.
  const tabsRef = useRef(tabs);
  const activeIdRef = useRef(activeId);
  const focusedPaneRef = useRef(focusedPane);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  useEffect(() => {
    focusedPaneRef.current = focusedPane;
  }, [focusedPane]);

  useEffect(() => {
    saveTabs(tabs, activeId);
  }, [tabs, activeId]);

  // Snap `activeId` to a tab that actually exists — guards against a
  // closed active tab leaving the shell pointing at a missing id.
  useEffect(() => {
    if (!tabs.some((t) => t.id === activeId) && tabs[0]) {
      setActiveId(tabs[0].id);
    }
  }, [tabs, activeId]);

  // Keep focusedPane inside the active tab.
  useEffect(() => {
    const active = tabs.find((t) => t.id === activeId);
    if (!active) return;
    const leaves = collectLeafIds(active.root);
    if (!leaves.includes(focusedPane)) setFocusedPane(leaves[0]);
  }, [tabs, activeId, focusedPane]);

  // Auto-clear maximize when its pane no longer exists in the active
  // tab (could have been closed or dragged elsewhere).
  useEffect(() => {
    if (!maximizedPane) return;
    const active = tabs.find((t) => t.id === activeId);
    if (!active || !collectLeafIds(active.root).includes(maximizedPane)) {
      setMaximizedPane(null);
    }
  }, [tabs, activeId, maximizedPane]);

  const toggleMaximize = useCallback((paneId: string) => {
    setMaximizedPane((cur) => (cur === paneId ? null : paneId));
    bumpRevision();
  }, [bumpRevision]);

  // Suppress popup auto-hide once while the Terminal tab is mounted.
  // Shells (Claude Code especially) steal focus when children spawn;
  // without this the popup would dismiss itself mid-session.
  useEffect(() => {
    invoke('set_popup_auto_hide', { enabled: false }).catch(() => {});
    return () => {
      invoke('set_popup_auto_hide', { enabled: true }).catch(() => {});
    };
  }, []);

  // Re-fit on tab switch / tab count change so the newly-revealed
  // pane knows its real size.
  useEffect(() => {
    bumpRevision();
  }, [activeId, tabs.length, bumpRevision]);

  // ---- tab/pane mutators ------------------------------------------
  const addTab = useCallback(() => {
    setTabs((prev) => {
      if (prev.length >= MAX_TABS) return prev;
      const tabIds = new Set(prev.map((t) => t.id));
      const paneIds = allLeafIds(prev);
      const tabId = newTabId(tabIds);
      const paneId = newPaneId(paneIds);
      setActiveId(tabId);
      setFocusedPane(paneId);
      return [...prev, { id: tabId, root: leaf(paneId) }];
    });
  }, []);

  const closeTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      const target = prev.find((t) => t.id === tabId);
      if (!target) return prev;
      const next = closeTabOp(prev, tabId);
      if (next === prev) return prev;
      // Kill each pane's PTY so its shell child exits with the UI.
      for (const p of collectLeafIds(target.root)) ptyClose(p).catch(() => {});
      if (tabId === activeIdRef.current) {
        const idx = prev.findIndex((t) => t.id === tabId);
        const fallback = next[Math.max(0, idx - 1)] ?? next[0];
        setActiveId(fallback.id);
      }
      return next;
    });
  }, []);

  const splitPane = useCallback(
    (tabId: string, paneId: string, orientation: Orientation) => {
      setTabs((prev) => {
        const { tabs: next, newPaneId: created } = splitPaneOp(
          prev,
          tabId,
          paneId,
          orientation,
        );
        if (next !== prev && created) setFocusedPane(created);
        return next;
      });
      bumpRevision();
    },
    [bumpRevision],
  );

  const closePane = useCallback(
    (tabId: string, paneId: string) => {
      setTabs((prev) => {
        const next = closePaneOp(prev, tabId, paneId);
        if (next === prev) return prev;
        ptyClose(paneId).catch(() => {});
        const target = next.find((t) => t.id === tabId);
        if (target) {
          const leaves = collectLeafIds(target.root);
          if (!leaves.includes(focusedPaneRef.current)) {
            setFocusedPane(leaves[0]);
          }
        }
        return next;
      });
      bumpRevision();
    },
    [bumpRevision],
  );

  const setRatios = useCallback(
    (tabId: string, path: number[], index: number, absolutePct: number) => {
      setTabs((prev) => applyRatioDrag(prev, tabId, path, index, absolutePct));
    },
    [],
  );

  const renameTab = useCallback((tabId: string, label: string | undefined) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, label } : t)),
    );
  }, []);

  // ---- drag dispatcher --------------------------------------------
  const commitDrop = useCallback(
    (source: `tab:${string}` | `pane:${string}`, target: string, zone: DropPosition) => {
      if (source.startsWith('tab:') && target.startsWith('tab:')) {
        setTabs((prev) =>
          reorderTabs(
            prev,
            source.slice('tab:'.length),
            target.slice('tab:'.length),
            zone,
          ),
        );
        return;
      }
      if (source.startsWith('pane:')) {
        const pid = source.slice('pane:'.length);
        if (target.startsWith('tab:')) {
          const destTabId = target.slice('tab:'.length);
          setTabs((prev) => {
            const res = movePaneToTab(prev, pid, destTabId);
            if (res.tabs === prev) return prev;
            if (res.activateTabId) setActiveId(res.activateTabId);
            if (res.focusPaneId) setFocusedPane(res.focusPaneId);
            return res.tabs;
          });
          bumpRevision();
          return;
        }
        if (target.startsWith('pane:')) {
          const destPaneId = target.slice('pane:'.length);
          setTabs((prev) => {
            const res = dropPaneOnPane(prev, pid, destPaneId, zone);
            if (res.tabs === prev) return prev;
            if (res.activateTabId) setActiveId(res.activateTabId);
            if (res.focusPaneId) setFocusedPane(res.focusPaneId);
            return res.tabs;
          });
          bumpRevision();
        }
      }
    },
    [bumpRevision],
  );

  const { dragState, beginDrag, dropOverTab } = useDrag(commitDrop);

  // ---- keyboard shortcuts -----------------------------------------
  // ⌘T new tab, ⌘W close pane-if-split-else-tab, ⌘1..⌘8 switch,
  // ⌘D / ⌘⇧D split, ⌘⌥←/→ cycle pane focus. Captured at document
  // level so browser defaults (⌘T opens a new browser tab in dev)
  // never steal the keypress.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // macOS convention: Cmd is the chord modifier; Ctrl must pass
      // through so the shell still receives ^C / ^Z / ^D / ^T etc.
      // Treating `ctrlKey` as interchangeable with `metaKey` here would
      // hijack those canonical terminal chords.
      if (!e.metaKey) return;
      const key = e.key.toLowerCase();

      if (e.altKey && (key === 'arrowleft' || key === 'arrowright')) {
        const curTabs = tabsRef.current;
        const curTab = curTabs.find((t) => t.id === activeIdRef.current);
        if (curTab) {
          const leaves = collectLeafIds(curTab.root);
          if (leaves.length > 1) {
            e.preventDefault();
            e.stopPropagation();
            const idx = leaves.indexOf(focusedPaneRef.current);
            const next =
              key === 'arrowright'
                ? leaves[(idx + 1) % leaves.length]
                : leaves[(idx - 1 + leaves.length) % leaves.length];
            setFocusedPane(next);
          }
        }
        return;
      }
      if (e.altKey) return;

      if (key === 't') {
        e.preventDefault();
        e.stopPropagation();
        addTab();
        return;
      }
      if (key === 'w') {
        e.preventDefault();
        e.stopPropagation();
        const curTabs = tabsRef.current;
        const curTab = curTabs.find((t) => t.id === activeIdRef.current);
        if (curTab && countLeaves(curTab.root) > 1) {
          closePane(curTab.id, focusedPaneRef.current);
          return;
        }
        if (curTabs.length > 1) {
          closeTab(activeIdRef.current);
          return;
        }
        // Last tab + last pane: mirror native macOS ⌘W by hiding the popup.
        // Same path as Escape / tray toggle, so focus bookkeeping is right
        // across the embedded webviews.
        invoke('hide_popup').catch(() => {});
        return;
      }
      if (key === 'd') {
        const curTabs = tabsRef.current;
        const curTab = curTabs.find((t) => t.id === activeIdRef.current);
        if (!curTab || countLeaves(curTab.root) >= MAX_PANES_PER_TAB) return;
        e.preventDefault();
        e.stopPropagation();
        const orientation: Orientation = e.shiftKey ? 'column' : 'row';
        splitPane(curTab.id, focusedPaneRef.current, orientation);
        return;
      }
      if (key === 'e' && !e.shiftKey) {
        // ⌘E toggles maximize on the focused pane. ⌘⇧E is compose (pane-local).
        const curTabs = tabsRef.current;
        const curTab = curTabs.find((t) => t.id === activeIdRef.current);
        if (!curTab || countLeaves(curTab.root) < 2) return;
        e.preventDefault();
        e.stopPropagation();
        toggleMaximize(focusedPaneRef.current);
        return;
      }
      if (key >= '1' && key <= '8') {
        const n = Number(key);
        const curTabs = tabsRef.current;
        if (curTabs[n - 1]) {
          e.preventDefault();
          e.stopPropagation();
          setActiveId(curTabs[n - 1].id);
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [addTab, closePane, closeTab, splitPane, toggleMaximize]);

  return (
    <div className="h-full flex flex-col">
      <TabBar
        tabs={tabs}
        activeId={activeId}
        dropOverTab={dropOverTab}
        dropZone={
          dragState && dropOverTab && dragState.source.startsWith('tab:')
            ? dragState.zone
            : null
        }
        onActivate={setActiveId}
        onClose={closeTab}
        onAdd={addTab}
        onRename={renameTab}
        onTabDragStart={(tabId, label) => beginDrag(`tab:${tabId}`, label)}
      />
      <div className="flex-1 relative" style={{ minHeight: 0 }}>
        {tabs.map((t) => (
          <TabContent
            key={t.id}
            tab={t}
            visible={t.id === activeId}
            focusedPane={focusedPane}
            setFocusedPane={setFocusedPane}
            onSplit={(paneId, orientation) => splitPane(t.id, paneId, orientation)}
            onClosePane={(paneId) => closePane(t.id, paneId)}
            onRatios={(path, index, pct) => setRatios(t.id, path, index, pct)}
            onPaneDragStart={(pid, label) => beginDrag(`pane:${pid}`, label)}
            maximizedPane={t.id === activeId ? maximizedPane : null}
            onToggleMaximize={toggleMaximize}
            revision={revision}
          />
        ))}
        {dragState && (
          <DragGhost
            x={dragState.x}
            y={dragState.y}
            label={dragState.label}
            zone={dragState.zone}
            hasTarget={!!dragState.target}
          />
        )}
      </div>
    </div>
  );
};

// Explicit tabLabel re-export so module-level consumers that read
// labels (e.g. future e2e hooks) don't need to reach into `state/`.
export { tabLabel };
