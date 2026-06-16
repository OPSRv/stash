// Central editor store for the Canvas module. A tiny external store
// (useSyncExternalStore) rather than a context+reducer: the Stage, tool rail,
// Layers panel and Inspector all read and write the same scene, and Konva's
// per-frame drag updates stay OUT of React — components only commit discrete
// changes here (drag end, transform end, draw end), so re-renders stay coarse.

import { useSyncExternalStore } from 'react';
import {
  defaultBackdrop,
  nid,
  type Backdrop,
  type CanvasNode,
  type CanvasProject,
  type ToolKind,
} from './types';

interface ProjectUi {
  tool: ToolKind;
  selectedIds: string[];
  /** Node currently being text-edited (Text tool), if any. */
  editingId: string | null;
}

interface EditorState {
  projects: CanvasProject[];
  activeId: string;
  ui: Record<string, ProjectUi>;
  /** Cross-tab layer clipboard — deep-cloned nodes, lossless (still vector). */
  clipboard: CanvasNode[] | null;
}

interface History {
  past: Array<Pick<CanvasProject, 'nodes' | 'backdrop'>>;
  future: Array<Pick<CanvasProject, 'nodes' | 'backdrop'>>;
}

const HISTORY_LIMIT = 80;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const blankProject = (title: string): CanvasProject => ({
  id: nid('proj'),
  title,
  width: 1200,
  height: 750,
  backdrop: defaultBackdrop(),
  nodes: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const blankUi = (): ProjectUi => ({
  tool: 'select',
  selectedIds: [],
  editingId: null,
});

class CanvasStore {
  private state: EditorState;
  private listeners = new Set<() => void>();
  private histories = new Map<string, History>();

  constructor() {
    const first = blankProject('Untitled 1');
    this.state = {
      projects: [first],
      activeId: first.id,
      ui: { [first.id]: blankUi() },
      clipboard: null,
    };
    this.histories.set(first.id, { past: [], future: [] });
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): EditorState => this.state;

  private emit() {
    for (const l of this.listeners) l();
  }

  private set(next: EditorState) {
    this.state = next;
    this.emit();
  }

  // ---- project (tab) lifecycle ------------------------------------------

  activeProject(): CanvasProject | undefined {
    return this.state.projects.find((p) => p.id === this.state.activeId);
  }

  ui(projectId: string): ProjectUi {
    return this.state.ui[projectId] ?? blankUi();
  }

  newProject(initialNode?: CanvasNode): string {
    const n = this.state.projects.length + 1;
    const proj = blankProject(`Untitled ${n}`);
    if (initialNode) {
      proj.nodes = [initialNode];
      proj.width = Math.max(proj.width, 'width' in initialNode ? (initialNode as { width: number }).width : proj.width);
    }
    this.histories.set(proj.id, { past: [], future: [] });
    this.set({
      ...this.state,
      projects: [...this.state.projects, proj],
      activeId: proj.id,
      ui: { ...this.state.ui, [proj.id]: blankUi() },
    });
    return proj.id;
  }

  closeProject(id: string) {
    const projects = this.state.projects.filter((p) => p.id !== id);
    this.histories.delete(id);
    const ui = { ...this.state.ui };
    delete ui[id];
    let next = projects;
    if (next.length === 0) {
      const fresh = blankProject('Untitled 1');
      this.histories.set(fresh.id, { past: [], future: [] });
      ui[fresh.id] = blankUi();
      next = [fresh];
    }
    const activeId =
      this.state.activeId === id ? next[next.length - 1].id : this.state.activeId;
    this.set({ ...this.state, projects: next, activeId, ui });
  }

  setActive(id: string) {
    if (id === this.state.activeId) return;
    this.set({ ...this.state, activeId: id });
  }

  /** Replace the in-memory projects with the set loaded from disk. Resets per
   *  project ui + history. No-op on an empty list so we never wipe the working
   *  default before persistence has anything to offer. */
  hydrate(projects: CanvasProject[]) {
    if (projects.length === 0) return;
    const ui: Record<string, ProjectUi> = {};
    this.histories.clear();
    for (const p of projects) {
      ui[p.id] = blankUi();
      this.histories.set(p.id, { past: [], future: [] });
    }
    this.set({
      projects,
      activeId: projects[0].id,
      ui,
      clipboard: this.state.clipboard,
    });
  }

  renameProject(id: string, title: string) {
    this.set({
      ...this.state,
      projects: this.state.projects.map((p) =>
        p.id === id ? { ...p, title } : p,
      ),
    });
  }

  setProjectSize(id: string, width: number, height: number) {
    this.set({
      ...this.state,
      projects: this.state.projects.map((p) =>
        p.id === id ? { ...p, width, height } : p,
      ),
    });
  }

  // ---- ui ----------------------------------------------------------------

  setTool(projectId: string, tool: ToolKind) {
    this.patchUi(projectId, { tool, editingId: null });
  }

  setSelected(projectId: string, selectedIds: string[]) {
    this.patchUi(projectId, { selectedIds });
  }

  setEditing(projectId: string, editingId: string | null) {
    this.patchUi(projectId, { editingId });
  }

  private patchUi(projectId: string, patch: Partial<ProjectUi>) {
    const cur = this.ui(projectId);
    this.set({
      ...this.state,
      ui: { ...this.state.ui, [projectId]: { ...cur, ...patch } },
    });
  }

  // ---- scene mutations ---------------------------------------------------

  private pushHistory(projectId: string, snap: Pick<CanvasProject, 'nodes' | 'backdrop'>) {
    const h = this.histories.get(projectId) ?? { past: [], future: [] };
    h.past.push(clone(snap));
    if (h.past.length > HISTORY_LIMIT) h.past.shift();
    h.future = [];
    this.histories.set(projectId, h);
  }

  /** Apply a recipe to a project's scene, snapshotting for undo first. */
  private mutate(
    projectId: string,
    recipe: (p: CanvasProject) => void,
    opts: { history?: boolean } = {},
  ) {
    const proj = this.state.projects.find((p) => p.id === projectId);
    if (!proj) return;
    if (opts.history !== false) {
      this.pushHistory(projectId, { nodes: proj.nodes, backdrop: proj.backdrop });
    }
    const draft = clone(proj);
    recipe(draft);
    draft.updatedAt = Date.now();
    this.set({
      ...this.state,
      projects: this.state.projects.map((p) => (p.id === projectId ? draft : p)),
    });
  }

  addNode(projectId: string, node: CanvasNode, opts: { select?: boolean } = {}) {
    this.mutate(projectId, (p) => {
      p.nodes.push(node);
      maybeAutoBackdrop(p);
    });
    if (opts.select !== false) {
      this.patchUi(projectId, {
        selectedIds: [node.id],
        tool: node.tool === 'text' ? this.ui(projectId).tool : 'select',
      });
    }
  }

  updateNode(projectId: string, id: string, patch: Partial<CanvasNode>) {
    this.mutate(projectId, (p) => {
      const i = p.nodes.findIndex((n) => n.id === id);
      if (i >= 0) p.nodes[i] = { ...p.nodes[i], ...patch } as CanvasNode;
    });
  }

  /** Snapshot the scene for undo once, at the start of a live gesture (drag),
   *  so the whole gesture collapses to a single undo step. */
  beginHistory(projectId: string) {
    const proj = this.state.projects.find((p) => p.id === projectId);
    if (proj) this.pushHistory(projectId, { nodes: proj.nodes, backdrop: proj.backdrop });
  }

  /** Per-frame position update during a drag — no history entry, so the
   *  backdrop (which is derived from node bounds) grows live as you move.
   *  Shallow on purpose: only the moved node is recreated, so we never
   *  deep-clone image `src` data-URLs 60×/second. */
  updateNodeLive(projectId: string, id: string, patch: Partial<CanvasNode>) {
    const proj = this.state.projects.find((p) => p.id === projectId);
    if (!proj) return;
    const nodes = proj.nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as CanvasNode) : n));
    const draft = { ...proj, nodes, updatedAt: Date.now() };
    this.set({
      ...this.state,
      projects: this.state.projects.map((p) => (p.id === projectId ? draft : p)),
    });
  }

  updateStyle(projectId: string, ids: string[], patch: Partial<CanvasNode['style']>) {
    this.mutate(projectId, (p) => {
      p.nodes = p.nodes.map((n) =>
        ids.includes(n.id) ? { ...n, style: { ...n.style, ...patch } } : n,
      );
    });
  }

  removeNodes(projectId: string, ids: string[]) {
    this.mutate(projectId, (p) => {
      p.nodes = p.nodes.filter((n) => !ids.includes(n.id));
      maybeAutoBackdrop(p);
    });
    const cur = this.ui(projectId);
    this.patchUi(projectId, {
      selectedIds: cur.selectedIds.filter((s) => !ids.includes(s)),
    });
  }

  /** Move selected layers up/down in z-order (Layers panel). */
  reorder(projectId: string, id: string, dir: -1 | 1) {
    this.mutate(projectId, (p) => {
      const i = p.nodes.findIndex((n) => n.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= p.nodes.length) return;
      [p.nodes[i], p.nodes[j]] = [p.nodes[j], p.nodes[i]];
    });
  }

  /** Reorder the whole node list to the given id order (bottom-first). Backs
   *  drag-and-drop in the Layers panel. */
  reorderNodes(projectId: string, orderedIds: string[]) {
    this.mutate(projectId, (p) => {
      const byId = new Map(p.nodes.map((n) => [n.id, n]));
      const next = orderedIds.map((id) => byId.get(id)).filter((n): n is CanvasNode => !!n);
      // Append any nodes not present in the order list (defensive).
      for (const n of p.nodes) if (!orderedIds.includes(n.id)) next.push(n);
      p.nodes = next;
    });
  }

  bringToFront(projectId: string, ids: string[]) {
    this.mutate(projectId, (p) => {
      const sel = p.nodes.filter((n) => ids.includes(n.id));
      const rest = p.nodes.filter((n) => !ids.includes(n.id));
      p.nodes = [...rest, ...sel];
    });
  }

  sendToBack(projectId: string, ids: string[]) {
    this.mutate(projectId, (p) => {
      const sel = p.nodes.filter((n) => ids.includes(n.id));
      const rest = p.nodes.filter((n) => !ids.includes(n.id));
      p.nodes = [...sel, ...rest];
    });
  }

  /** Duplicate selected nodes in-place (offset), select the copies. */
  duplicate(projectId: string, ids: string[]) {
    const proj = this.state.projects.find((p) => p.id === projectId);
    if (!proj) return;
    const picked = proj.nodes.filter((n) => ids.includes(n.id));
    if (!picked.length) return;
    const fresh = picked.map((n) => ({ ...clone(n), id: nid(n.tool), x: n.x + 24, y: n.y + 24 }));
    this.mutate(projectId, (p) => {
      p.nodes.push(...fresh);
    });
    this.patchUi(projectId, { selectedIds: fresh.map((n) => n.id), tool: 'select' });
  }

  toggleVisible(projectId: string, id: string) {
    this.mutate(projectId, (p) => {
      const n = p.nodes.find((x) => x.id === id);
      if (n) n.visible = !n.visible;
    });
  }

  toggleLocked(projectId: string, id: string) {
    this.mutate(projectId, (p) => {
      const n = p.nodes.find((x) => x.id === id);
      if (n) n.locked = !n.locked;
    });
  }

  setBackdrop(projectId: string, patch: Partial<Backdrop>) {
    this.mutate(projectId, (p) => {
      p.backdrop = { ...p.backdrop, ...patch };
    });
  }

  // ---- clipboard (cross-tab) --------------------------------------------

  copySelection(projectId: string) {
    const proj = this.state.projects.find((p) => p.id === projectId);
    if (!proj) return;
    const ids = this.ui(projectId).selectedIds;
    const picked = proj.nodes.filter((n) => ids.includes(n.id));
    if (picked.length) this.set({ ...this.state, clipboard: clone(picked) });
  }

  pasteClipboard(targetProjectId: string) {
    const cb = this.state.clipboard;
    if (!cb || cb.length === 0) return;
    const fresh = cb.map((n) => ({
      ...clone(n),
      id: nid(n.tool),
      x: n.x + 24,
      y: n.y + 24,
    }));
    this.mutate(targetProjectId, (p) => {
      p.nodes.push(...fresh);
      maybeAutoBackdrop(p);
    });
    this.patchUi(targetProjectId, {
      selectedIds: fresh.map((n) => n.id),
      tool: 'select',
    });
  }

  // ---- history -----------------------------------------------------------

  undo(projectId: string) {
    const h = this.histories.get(projectId);
    const proj = this.state.projects.find((p) => p.id === projectId);
    if (!h || !proj || h.past.length === 0) return;
    const prev = h.past.pop()!;
    h.future.push(clone({ nodes: proj.nodes, backdrop: proj.backdrop }));
    this.mutate(projectId, (p) => {
      p.nodes = prev.nodes;
      p.backdrop = prev.backdrop;
    }, { history: false });
  }

  redo(projectId: string) {
    const h = this.histories.get(projectId);
    const proj = this.state.projects.find((p) => p.id === projectId);
    if (!h || !proj || h.future.length === 0) return;
    const next = h.future.pop()!;
    h.past.push(clone({ nodes: proj.nodes, backdrop: proj.backdrop }));
    this.mutate(projectId, (p) => {
      p.nodes = next.nodes;
      p.backdrop = next.backdrop;
    }, { history: false });
  }

  canUndo(projectId: string) {
    return (this.histories.get(projectId)?.past.length ?? 0) > 0;
  }
  canRedo(projectId: string) {
    return (this.histories.get(projectId)?.future.length ?? 0) > 0;
  }
}

/** When a scene gains a 2nd image node, switch the backdrop on automatically
 *  (the signature multi-image behaviour). Never forces it off — once the user
 *  has toggled it they own it. */
function maybeAutoBackdrop(p: CanvasProject) {
  const images = p.nodes.filter((n) => n.tool === 'image').length;
  if (images >= 2 && !p.backdrop.enabled && p.backdrop.preset !== '__user__') {
    p.backdrop = { ...p.backdrop, enabled: true };
  }
}

export const canvasStore = new CanvasStore();

/** Subscribe a component to the whole editor state. */
export const useCanvas = (): EditorState =>
  useSyncExternalStore(canvasStore.subscribe, canvasStore.getSnapshot);
