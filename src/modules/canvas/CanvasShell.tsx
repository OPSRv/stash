import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { IconButton } from '../../shared/ui/IconButton';
import { Button } from '../../shared/ui/Button';
import { CopyIcon, DownloadIcon, PlusIcon, CloseIcon } from '../../shared/ui/icons';
import { useToast } from '../../shared/ui/Toast';
import { ContextMenu, type ContextMenuItem } from '../../shared/ui/ContextMenu';
import { accent } from '../../shared/theme/accent';
import { CanvasStage, type CanvasStageHandle, type ContextMenuInfo } from './CanvasStage';
import { ToolRail } from './ToolRail';
import { LayersPanel } from './LayersPanel';
import { Inspector } from './Inspector';
import { canvasStore, useCanvas } from './store';
import {
  canvasCaptureImage,
  canvasCaptureText,
  canvasDeleteProject,
  canvasListProjects,
  canvasSaveAsset,
  canvasSaveProject,
  canvasWritePng,
  copyPngToClipboard,
  probeImageSrc,
  rasterizeSvgFile,
  readClipboardImage,
  readImageFile,
  type PastedImage,
} from './api';
import { projectFromRecord, sceneToJson } from './persist';
import { CANVAS_PASTE_EVENT } from './pendingImage';
import { TOOLS } from './tools';
import { DEFAULT_STYLE, nid, type ImageNode, type ToolKind } from './types';

const HOTKEYS: Record<string, ToolKind> = Object.fromEntries(
  TOOLS.map((t) => [t.hotkey, t.kind]),
);
const isTextTarget = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
};

const Mini = ({ d }: { d: string }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const UndoIcon = () => <Mini d="M9 7 4 12l5 5M4 12h11a5 5 0 0 1 0 10h-1" />;
const RedoIcon = () => <Mini d="M15 7l5 5-5 5M20 12H9a5 5 0 0 0 0 10h1" />;
const FitIcon = () => <Mini d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />;
const PasteIcon = () => <Mini d="M9 4h6v3H9zM7 5H5v15h14V5h-2M9 12h6M9 16h4" />;
const PanelIcon = () => <Mini d="M4 5h16v14H4zM14 5v14" />;
const CaptureImgIcon = () => <Mini d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M8 12h8M9 9h6v6H9z" />;
const CaptureTextIcon = () => <Mini d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M8 9h8M8 12h8M8 15h5" />;

export const CanvasShell = () => {
  const state = useCanvas();
  const { toast } = useToast();
  const stageRef = useRef<CanvasStageHandle>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuInfo | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  const hydrated = useRef(false);
  const saveTimer = useRef<number | null>(null);

  const project = state.projects.find((p) => p.id === state.activeId) ?? state.projects[0];
  const ui = state.ui[project.id] ?? { tool: 'select' as const, selectedIds: [], editingId: null };

  // ---- load persisted projects once on first mount ----------------------
  useEffect(() => {
    let cancelled = false;
    canvasListProjects()
      .then(async (records) => {
        if (cancelled || records.length === 0) return;
        const loaded = (await Promise.all(records.map((r) => projectFromRecord(r.scene_json)))).filter(
          (p): p is NonNullable<typeof p> => p !== null,
        );
        if (!cancelled) canvasStore.hydrate(loaded);
      })
      .catch(() => {})
      .finally(() => {
        hydrated.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- debounced autosave of the active project -------------------------
  useEffect(() => {
    if (!hydrated.current) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    const idx = state.projects.findIndex((p) => p.id === project.id);
    saveTimer.current = window.setTimeout(() => {
      void canvasSaveProject({
        id: project.id,
        title: project.title,
        scene_json: sceneToJson(project),
        updated_at: project.updatedAt,
        sort_order: idx < 0 ? 0 : idx,
      }).catch(() => {});
    }, 800);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, project.updatedAt, project.title]);

  const addImageNode = (img: PastedImage, opts: { newProject?: boolean } = {}) => {
    const pid = opts.newProject ? canvasStore.newProject() : project.id;
    const existingImages = opts.newProject
      ? 0
      : project.nodes.filter((n) => n.tool === 'image').length;
    const first = existingImages === 0;
    if (first) canvasStore.setProjectSize(pid, img.width, img.height);
    const offset = existingImages * 48;
    const id = nid('image');
    const node: ImageNode = {
      id,
      tool: 'image',
      name: 'Image',
      visible: true,
      locked: false,
      x: first ? 0 : offset + 40,
      y: first ? 0 : offset + 40,
      rotation: 0,
      assetId: id,
      src: img.src,
      width: img.width,
      height: img.height,
      style: { ...DEFAULT_STYLE },
    };
    canvasStore.addNode(pid, node);
    // Offload bytes to the asset store so they never bloat scene_json.
    void canvasSaveAsset(id, img.src).catch(() => {});
  };

  // ---- capture events from the global hotkeys ---------------------------
  useEffect(() => {
    const unImg = listen<string>('canvas:open-capture', async (e) => {
      const img = await probeImageSrc(`data:image/png;base64,${e.payload}`);
      if (img) addImageNode(img, { newProject: true });
    });
    const unTxt = listen<{ text: string }>('canvas:ocr-text', (e) => {
      const text = e.payload?.text ?? '';
      toast(
        text.trim()
          ? { title: 'Text copied', description: text.slice(0, 80) }
          : { title: 'No text found', variant: 'error' },
      );
    });
    return () => {
      void unImg.then((f) => f());
      void unTxt.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPaste = async () => {
    const img = await readClipboardImage();
    if (img) addImageNode(img);
    else if (state.clipboard?.length) canvasStore.pasteClipboard(project.id);
    else toast({ title: 'Clipboard has no image', variant: 'error' });
  };

  // "Open in Canvas" hand-off from the Clipboard tab: it copies the image to
  // the OS clipboard, navigates here, and dispatches this event so we paste it.
  // Guarded so repeated pings from the sender only paste once.
  useEffect(() => {
    let handled = false;
    const handler = () => {
      if (handled) return;
      handled = true;
      void onPaste().finally(() => {
        window.setTimeout(() => {
          handled = false;
        }, 1000);
      });
    };
    window.addEventListener(CANVAS_PASTE_EVENT, handler);
    return () => window.removeEventListener(CANVAS_PASTE_EVENT, handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onCopyVisible = async () => {
    const url = stageRef.current?.toPng(2);
    if (!url) return void toast({ title: 'Nothing to copy', variant: 'error' });
    try {
      await copyPngToClipboard(url);
      toast({ title: 'Copied to clipboard' });
    } catch (e) {
      toast({ title: 'Copy failed', description: String(e), variant: 'error' });
    }
  };

  const onSave = async () => {
    const url = stageRef.current?.toPng(2);
    if (!url) return void toast({ title: 'Nothing to save', variant: 'error' });
    // Suspend popup auto-hide so the native save dialog's blur doesn't dismiss us.
    await invoke('set_popup_auto_hide', { enabled: false }).catch(() => {});
    try {
      const path = await saveDialog({
        defaultPath: `${project.title || 'canvas'}.png`,
        filters: [{ name: 'PNG', extensions: ['png'] }],
      });
      if (path) {
        await canvasWritePng(path, url);
        toast({ title: 'Saved' });
      }
    } catch (e) {
      toast({ title: 'Save failed', description: String(e), variant: 'error' });
    } finally {
      await invoke('set_popup_auto_hide', { enabled: true }).catch(() => {});
    }
  };

  const onCaptureImage = async () => {
    const b64 = await canvasCaptureImage();
    if (!b64) return;
    const img = await probeImageSrc(`data:image/png;base64,${b64}`);
    if (img) addImageNode(img, { newProject: true });
  };

  const onCaptureText = async () => {
    const text = await canvasCaptureText();
    if (text === null) return; // cancelled
    toast(
      text.trim()
        ? { title: 'Text copied', description: text.slice(0, 80) }
        : { title: 'No text found', variant: 'error' },
    );
  };

  const onClose = (id: string) => {
    canvasStore.closeProject(id);
    void canvasDeleteProject(id).catch(() => {});
  };

  // Shell-level shortcuts: clipboard (system image + internal layers).
  // All editor shortcuts run at the window level so ⌘V / ⌘Z / tool keys work the
  // moment the Canvas tab is open — no need to click the stage first. Guarded so
  // they only fire when this tab is the visible one and focus isn't in a field.
  keyHandlerRef.current = (e: KeyboardEvent) => {
    if (!rootRef.current || rootRef.current.offsetParent === null) return;
    if (isTextTarget(e.target) || ui.editingId) return;
    const meta = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    const sel = ui.selectedIds;
    if (meta && k === 'c') {
      if (sel.length) {
        canvasStore.copySelection(project.id);
        toast({ title: `Copied ${sel.length} layer(s)` });
      }
      return;
    }
    if (meta && k === 'v') {
      e.preventDefault();
      void onPaste();
      return;
    }
    if (meta && k === 's') {
      e.preventDefault();
      void onSave();
      return;
    }
    if (meta && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) canvasStore.redo(project.id);
      else canvasStore.undo(project.id);
      return;
    }
    if (meta && k === 'd') {
      e.preventDefault();
      if (sel.length) canvasStore.duplicate(project.id, sel);
      return;
    }
    if (meta) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (sel.length) {
        e.preventDefault();
        canvasStore.removeNodes(project.id, sel);
      }
      return;
    }
    if (e.key === 'Escape') {
      if (sel.length) {
        e.preventDefault();
        canvasStore.setSelected(project.id, []);
      }
      return;
    }
    if (HOTKEYS[k]) canvasStore.setTool(project.id, HOTKEYS[k]);
  };

  useEffect(() => {
    const fn = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, []);

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const file = [...e.dataTransfer.files].find(
      (f) => f.type.startsWith('image/') || f.name.toLowerCase().endsWith('.svg'),
    );
    if (!file) return;
    const isSvg = file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');
    const img = isSvg ? await rasterizeSvgFile(file) : await readImageFile(file);
    if (img) addImageNode(img);
  };

  const menuItems = (): ContextMenuItem[] => {
    const sel = ui.selectedIds;
    if (sel.length) {
      return [
        { kind: 'action', label: 'Duplicate', shortcut: '⌘D', onSelect: () => canvasStore.duplicate(project.id, sel) },
        { kind: 'action', label: 'Copy', shortcut: '⌘C', onSelect: () => canvasStore.copySelection(project.id) },
        { kind: 'action', label: 'Bring to front', onSelect: () => canvasStore.bringToFront(project.id, sel) },
        { kind: 'action', label: 'Send to back', onSelect: () => canvasStore.sendToBack(project.id, sel) },
        { kind: 'separator' },
        { kind: 'action', label: 'Delete', tone: 'danger', shortcut: '⌫', onSelect: () => canvasStore.removeNodes(project.id, sel) },
      ];
    }
    return [
      { kind: 'action', label: 'Paste', shortcut: '⌘V', onSelect: () => void onPaste() },
      { kind: 'action', label: 'Select all', onSelect: () => canvasStore.setSelected(project.id, project.nodes.map((n) => n.id)) },
    ];
  };

  return (
    <div
      ref={rootRef}
      className="flex h-full w-full flex-col"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      {/* project tabs + actions */}
      <div className="flex items-center gap-1 border-b hair px-1.5 py-1">
        <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {state.projects.map((p) => {
            const active = p.id === project.id;
            return (
              <div
                key={p.id}
                className="group flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-body"
                style={active ? { background: accent(0.14), boxShadow: `inset 0 0 0 1px ${accent(0.24)}` } : undefined}
              >
                {renaming === p.id ? (
                  <input
                    autoFocus
                    defaultValue={p.title}
                    onBlur={(e) => {
                      canvasStore.renameProject(p.id, e.target.value || p.title);
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                    className="w-24 bg-transparent outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => canvasStore.setActive(p.id)}
                    onDoubleClick={() => setRenaming(p.id)}
                    className={active ? 't-primary' : 't-tertiary'}
                  >
                    {p.title}
                  </button>
                )}
                <IconButton title="Close tab" onClick={() => onClose(p.id)} tooltipSide="bottom">
                  <CloseIcon />
                </IconButton>
              </div>
            );
          })}
          <IconButton title="New canvas" onClick={() => canvasStore.newProject()}>
            <PlusIcon />
          </IconButton>
        </div>

        <div className="flex items-center gap-0.5">
          <IconButton title="Capture region → annotate (⌘⇧S)" onClick={() => void onCaptureImage()}>
            <CaptureImgIcon />
          </IconButton>
          <IconButton title="Capture region → OCR text (⌘⇧O)" onClick={() => void onCaptureText()}>
            <CaptureTextIcon />
          </IconButton>
          <span className="mx-0.5 h-4 w-px bg-[var(--color-border-hair,rgba(128,128,128,0.2))]" />
          <IconButton title="Undo (⌘Z)" disabled={!canvasStore.canUndo(project.id)} onClick={() => canvasStore.undo(project.id)}>
            <UndoIcon />
          </IconButton>
          <IconButton title="Redo (⌘⇧Z)" disabled={!canvasStore.canRedo(project.id)} onClick={() => canvasStore.redo(project.id)}>
            <RedoIcon />
          </IconButton>
          <IconButton title="Fit to view" onClick={() => stageRef.current?.fit()}>
            <FitIcon />
          </IconButton>
          <IconButton title="Paste image / layers (⌘V)" onClick={() => void onPaste()}>
            <PasteIcon />
          </IconButton>
          <IconButton title="Save PNG (⌘S)" onClick={() => void onSave()}>
            <DownloadIcon />
          </IconButton>
          <Button size="sm" variant="soft" leadingIcon={<CopyIcon />} onClick={() => void onCopyVisible()}>
            Copy visible
          </Button>
          <IconButton title={panelOpen ? 'Hide panels' : 'Show panels'} active={panelOpen} onClick={() => setPanelOpen((v) => !v)}>
            <PanelIcon />
          </IconButton>
        </div>
      </div>

      {/* editor body */}
      <div className="flex min-h-0 flex-1">
        <ToolRail tool={ui.tool} onPick={(t) => canvasStore.setTool(project.id, t)} />
        <div className="relative min-w-0 flex-1 bg-[var(--color-bg-canvas)]">
          <CanvasStage
            ref={stageRef}
            project={project}
            tool={ui.tool}
            selectedIds={ui.selectedIds}
            editingId={ui.editingId}
            onContextMenu={setMenu}
          />
        </div>
        {panelOpen && (
          <div className="flex w-64 shrink-0 flex-col border-l hair">
            {/* Layers takes the flexible space and scrolls internally; the
                Inspector keeps a fixed share so the divider never jumps. */}
            <div className="min-h-0 flex-1 border-b hair">
              <LayersPanel project={project} selectedIds={ui.selectedIds} />
            </div>
            <div className="no-scrollbar shrink-0 overflow-y-auto" style={{ height: '42%' }}>
              <Inspector project={project} selectedIds={ui.selectedIds} />
            </div>
          </div>
        )}
      </div>

      <ContextMenu
        open={!!menu}
        x={menu?.clientX ?? 0}
        y={menu?.clientY ?? 0}
        items={menuItems()}
        onClose={() => setMenu(null)}
        label="Canvas actions"
      />
    </div>
  );
};
