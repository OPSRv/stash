/// Persistence + id helpers for the terminal tab workspace. Pure
/// functions so they're trivial to unit-test and reuse across the
/// shell, the drag manager, and tab state mutators.

import {
  MAX_PANES_PER_TAB,
  type Orientation,
  type PaneLeaf,
  type PaneNode,
  type PaneSplit,
  type Tab,
} from '../types';
import { collectLeafIds, countLeaves, isValidNode, leaf } from './paneTree';

/// v2 was the flat `panes: string[]` layout; v3 switched to the
/// recursive tree so 2×2 (and deeper) compositions work. On load we
/// prefer v3; if only v2 data exists we migrate once and persist into
/// v3 on the next save.
export const TABS_STORAGE_KEY = 'stash.terminal.tabs.v3';
export const LEGACY_TABS_STORAGE_KEY = 'stash.terminal.tabs.v2';
export const ACTIVE_TAB_STORAGE_KEY = 'stash.terminal.activeTab';

export const newTabId = (existing: Set<string>): string => {
  let n = 1;
  while (existing.has(`tab-${n}`)) n += 1;
  return `tab-${n}`;
};

export const newPaneId = (existing: Set<string>): string => {
  let n = 1;
  while (existing.has(`pane-${n}`)) n += 1;
  return `pane-${n}`;
};

export const allLeafIds = (tabs: Tab[]): Set<string> => {
  const s = new Set<string>();
  for (const t of tabs) for (const p of collectLeafIds(t.root)) s.add(p);
  return s;
};

type LegacyTab = {
  id: string;
  panes: string[];
  split?: Orientation;
  ratio?: number;
  label?: string;
};

const legacyToTree = (t: LegacyTab): PaneNode | null => {
  if (!Array.isArray(t.panes) || t.panes.length === 0) return null;
  if (t.panes.length === 1) return leaf(t.panes[0]);
  const orientation: Orientation = t.split ?? 'row';
  const n = t.panes.length;
  const first = t.ratio ?? 50;
  const ratios =
    n === 2
      ? [first, 100 - first]
      : [first, ...Array(n - 1).fill((100 - first) / (n - 1))];
  const children: PaneLeaf[] = t.panes.map(leaf);
  const split: PaneSplit = { kind: 'split', orientation, ratios, children };
  return split;
};

const validateTab = (t: unknown): Tab | null => {
  if (!t || typeof t !== 'object') return null;
  const raw = t as Partial<Tab> & { panes?: unknown };
  if (typeof raw.id !== 'string') return null;
  // v3 shape.
  if (raw.root && isValidNode(raw.root)) {
    const n = countLeaves(raw.root);
    if (n < 1 || n > MAX_PANES_PER_TAB) return null;
    return {
      id: raw.id,
      root: raw.root,
      label: typeof raw.label === 'string' ? raw.label : undefined,
    };
  }
  // v2 shape — migrate on the fly.
  if (Array.isArray(raw.panes) && raw.panes.every((p) => typeof p === 'string')) {
    const legacy = raw as unknown as LegacyTab;
    if (legacy.panes.length < 1 || legacy.panes.length > MAX_PANES_PER_TAB) return null;
    const tree = legacyToTree(legacy);
    if (!tree) return null;
    return { id: legacy.id, root: tree, label: legacy.label };
  }
  return null;
};

const readFromKey = (key: string): Tab[] | null => {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const valid: Tab[] = [];
    for (const t of parsed) {
      const ok = validateTab(t);
      if (ok) valid.push(ok);
    }
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
};

export const loadStoredTabs = (): Tab[] => {
  return (
    readFromKey(TABS_STORAGE_KEY) ??
    readFromKey(LEGACY_TABS_STORAGE_KEY) ??
    [{ id: 'tab-1', root: leaf('pane-1') }]
  );
};

export const loadStoredActive = (fallback: string): string => {
  try {
    const v = window.localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    if (v) return v;
  } catch {
    /* ignore */
  }
  return fallback;
};

export const saveTabs = (tabs: Tab[], activeId: string): void => {
  try {
    window.localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(tabs));
    window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, activeId);
  } catch {
    /* ignore */
  }
};

export const defaultTabLabel = (tab: Tab, idx: number): string => {
  const m = tab.id.match(/tab-(\d+)/);
  const n = m ? m[1] : String(idx + 1);
  return `Shell ${n}`;
};

export const tabLabel = (tab: Tab, idx: number): string => {
  const base = tab.label?.trim() || defaultTabLabel(tab, idx);
  // Show pane count as a compact badge when split so the user can tell
  // a 3-pane tab from a 2-pane tab without opening it.
  const n = countLeaves(tab.root);
  return n > 1 ? `${base} ⫴${n}` : base;
};
