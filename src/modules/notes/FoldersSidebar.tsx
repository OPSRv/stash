import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { IconButton } from '../../shared/ui/IconButton';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { ContextMenu, type ContextMenuItem } from '../../shared/ui/ContextMenu';
import { useSuppressibleConfirm } from '../../shared/hooks/useSuppressibleConfirm';
import { PencilIcon, TrashIcon } from '../../shared/ui/icons';
import { accent } from '../../shared/theme/accent';
import {
  notesFolderCreate,
  notesFolderDelete,
  notesFolderRename,
  notesFoldersList,
  notesFoldersReorder,
  type FolderFilter,
  type NoteFolder,
} from './api';
import {
  useActiveDrag,
  useIsDropTarget,
  usePointerDrag,
  type DragInfo,
  type DropTargetData,
} from './notesDnd';

type Props = {
  /** Currently active filter — drives the highlighted row. */
  selected: FolderFilter;
  onSelect: (filter: FolderFilter) => void;
};

type DropZone = 'all' | 'unfiled' | { folder: number };

const dropZoneAttr = (zone: DropZone, folderName?: string): string => {
  if (zone === 'all') return 'all';
  if (zone === 'unfiled') return 'unfiled';
  return `folder:${zone.folder}:${folderName ?? ''}`;
};

/** A single row inside the folders sidebar — encapsulates pointer-DnD
 *  hookup so each row can independently track its own "is it the current
 *  drop target?" state without prop-drilling. Source-of-drag is also wired
 *  here for actual folder rows so they can be reordered. */
const FolderRow = ({
  label,
  zone,
  filter,
  folder,
  selected,
  onSelect,
  onReorderDrop,
  onContextMenuRequest,
  onRenameClick,
  onDeleteClick,
  isInsertBefore,
  editingId,
  editName,
  setEditName,
  commitRename,
  editKey,
}: {
  label: string;
  zone: DropZone;
  filter: FolderFilter;
  folder?: NoteFolder;
  selected: FolderFilter;
  onSelect: (filter: FolderFilter) => void;
  onReorderDrop: (target: DropTargetData | null, source: DragInfo) => void;
  onContextMenuRequest?: (folderId: number, x: number, y: number) => void;
  onRenameClick?: (folder: NoteFolder) => void;
  onDeleteClick?: (folderId: number) => void;
  isInsertBefore: boolean;
  editingId: number | null;
  editName: string;
  setEditName: (s: string) => void;
  commitRename: (id: number) => void;
  editKey: (id: number) => (e: KeyboardEvent<HTMLInputElement>) => void;
}) => {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const isOver = useIsDropTarget(rowRef);
  const drag = useActiveDrag();

  // Folder rows are draggable for reorder. All / Unfiled rows are not —
  // they have no `folder` and the DOM node carries only drop-target meta.
  const dragInfo = folder ? { kind: 'folder' as const, id: folder.id } : null;
  const { ref: dragRef, isDragging } = usePointerDrag(
    dragInfo ?? { kind: 'folder', id: -1 },
    onReorderDrop,
  );
  // Bind whichever ref is needed — folders use the drag ref (which also
  // serves as the row's DOM ref), zones use rowRef directly.
  const setRef = (node: HTMLDivElement | null) => {
    rowRef.current = node;
    if (folder) dragRef.current = node;
  };

  const active = selected === filter;
  // Highlight when a note drag is hovering over this row. Folder reorder
  // gets a different visual cue (insert-bar above).
  const showNoteDropHighlight = drag?.kind === 'note' && isOver;

  const handleClick = () => onSelect(filter);

  return (
    <div className="relative">
      {isInsertBefore && (
        <div
          className="absolute -top-px left-2 right-2 h-0.5 z-10 rounded"
          style={{ background: accent(0.8) }}
          aria-hidden
        />
      )}
      <div
        ref={setRef}
        role="button"
        tabIndex={0}
        aria-pressed={active}
        data-drop-zone={dropZoneAttr(zone, folder?.name)}
        onClick={handleClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect(filter);
          }
        }}
        onContextMenu={
          folder && onContextMenuRequest
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                onContextMenuRequest(folder.id, e.clientX, e.clientY);
              }
            : undefined
        }
        className={`group flex items-center gap-1.5 px-3 py-1.5 text-meta cursor-pointer ring-focus transition-colors ${
          active ? 'row-active row-active-strong' : 'hover:bg-white/[0.03]'
        } ${isDragging ? 'opacity-40' : ''}`}
        style={
          showNoteDropHighlight
            ? { outline: `2px solid ${accent(0.85)}`, background: accent(0.12) }
            : undefined
        }
      >
        {folder && editingId === folder.id ? (
          <input
            autoFocus
            value={editName}
            onChange={(e) => setEditName(e.currentTarget.value)}
            onBlur={() => commitRename(folder.id)}
            onKeyDown={editKey(folder.id)}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 min-w-0 bg-transparent outline-none t-primary text-meta"
            data-no-drag
          />
        ) : (
          <>
            <span
              className="t-primary flex-1 min-w-0 truncate"
              style={folder ? undefined : { fontStyle: 'italic', opacity: 0.85 }}
            >
              {label}
            </span>
            {folder && onRenameClick && onDeleteClick && (
              <span
                className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex items-center gap-0.5"
                data-no-drag
              >
                <IconButton
                  title="Rename folder"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRenameClick(folder);
                  }}
                >
                  <PencilIcon size={11} />
                </IconButton>
                <IconButton
                  title="Delete folder"
                  tone="danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteClick(folder.id);
                  }}
                >
                  <TrashIcon size={11} />
                </IconButton>
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export const FoldersSidebar = ({ selected, onSelect }: Props) => {
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  /// Insert-bar id for the in-flight folder reorder. Set on every pointer
  /// move while a folder is being dragged so the row above the insert
  /// position renders an accent line. Cleared on drop / cancel.
  const [insertBeforeId, setInsertBeforeId] = useState<number | null | 'tail'>(
    null,
  );
  const draftInputRef = useRef<HTMLInputElement | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; folderId: number } | null>(
    null,
  );

  const reload = useCallback(async () => {
    const data = await notesFoldersList().catch(() => [] as NoteFolder[]);
    setFolders(Array.isArray(data) ? data : []);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (creating) draftInputRef.current?.focus();
  }, [creating]);

  // Live insert-position indicator while a folder is being reordered.
  useEffect(() => {
    const onMove = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        clientY: number;
        el: Element | null;
      };
      const cur = detail.el?.closest('[data-drop-zone]') as HTMLElement | null;
      if (!cur) {
        setInsertBeforeId(null);
        return;
      }
      const m = cur.dataset.dropZone?.match(/^folder:(\d+):/);
      if (!m) {
        setInsertBeforeId(null);
        return;
      }
      const overId = Number(m[1]);
      const rect = cur.getBoundingClientRect();
      const upper = detail.clientY < rect.top + rect.height / 2;
      if (upper) {
        setInsertBeforeId(overId);
      } else {
        const idx = folders.findIndex((f) => f.id === overId);
        const next = folders[idx + 1]?.id;
        setInsertBeforeId(next ?? 'tail');
      }
    };
    const onEnd = () => setInsertBeforeId(null);
    window.addEventListener('stash:notes-dnd-move', onMove);
    window.addEventListener('stash:notes-dnd-end', onEnd);
    return () => {
      window.removeEventListener('stash:notes-dnd-move', onMove);
      window.removeEventListener('stash:notes-dnd-end', onEnd);
    };
  }, [folders]);

  const drag = useActiveDrag();
  const isReorderingFolder = drag?.kind === 'folder';

  const commitCreate = useCallback(async () => {
    const name = draftName.trim();
    setCreating(false);
    setDraftName('');
    if (!name) return;
    const id = await notesFolderCreate(name);
    await reload();
    onSelect(id);
  }, [draftName, onSelect, reload]);

  const commitRename = useCallback(
    async (id: number) => {
      const name = editName.trim();
      const target = folders.find((f) => f.id === id);
      setEditingId(null);
      setEditName('');
      if (!target || !name || name === target.name) return;
      await notesFolderRename(id, name);
      await reload();
    },
    [editName, folders, reload],
  );

  const deleteConfirm = useSuppressibleConfirm<number>('notes.folders.delete');
  const performDelete = useCallback(
    async (id: number) => {
      await notesFolderDelete(id);
      if (typeof selected === 'number' && selected === id) onSelect('all');
      await reload();
    },
    [reload, selected, onSelect],
  );

  /** Handles drop callbacks from `usePointerDrag` on folder rows. The
   *  same handler covers reorder (folder-on-folder) — note drops are
   *  wired separately on the source side via `handleNoteDrop` below. */
  const handleFolderReorderDrop = useCallback(
    async (target: DropTargetData | null, source: { id: number }) => {
      if (!target || target.kind !== 'folder-reorder') return;
      const dragging = source.id;
      if (dragging === target.overId) return;
      const upper = target.clientY < target.rect.top + target.rect.height / 2;
      let beforeId: number | null;
      if (upper) {
        beforeId = target.overId;
      } else {
        const idx = folders.findIndex((f) => f.id === target.overId);
        beforeId = folders[idx + 1]?.id ?? null;
      }
      const next = folders.filter((f) => f.id !== dragging).map((f) => f.id);
      const insertAt = beforeId == null ? next.length : next.indexOf(beforeId);
      if (insertAt < 0) {
        next.push(dragging);
      } else {
        next.splice(insertAt, 0, dragging);
      }
      // Optimistic local reorder so the sidebar doesn't flicker.
      const reordered: NoteFolder[] = next.map((id, i) => {
        const f = folders.find((x) => x.id === id)!;
        return { ...f, sort_order: i };
      });
      setFolders(reordered);
      await notesFoldersReorder(next);
      await reload();
    },
    [folders, reload],
  );

  const draftKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commitCreate();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setCreating(false);
      setDraftName('');
    }
  };

  const editKey = (id: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commitRename(id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditingId(null);
      setEditName('');
    }
  };

  // Provided to row's renamed-from-context-menu / button paths.
  const onRenameClick = (f: NoteFolder) => {
    setEditingId(f.id);
    setEditName(f.name);
  };
  const onDeleteClick = (id: number) => {
    deleteConfirm.request(id, performDelete);
  };

  return (
    <div className="flex flex-col" data-testid="notes-folders">
      <div className="px-3 pt-2 pb-1 flex items-center justify-between">
        <span className="t-tertiary text-meta uppercase tracking-wide">Folders</span>
        <IconButton
          title="New folder"
          onClick={() => {
            setCreating(true);
            setDraftName('');
          }}
        >
          <span className="text-meta leading-none">+</span>
        </IconButton>
      </div>
      <FolderRow
        label="All notes"
        zone="all"
        filter="all"
        selected={selected}
        onSelect={onSelect}
        onReorderDrop={() => {}}
        isInsertBefore={false}
        editingId={editingId}
        editName={editName}
        setEditName={setEditName}
        commitRename={commitRename}
        editKey={editKey}
      />
      <FolderRow
        label="Unfiled"
        zone="unfiled"
        filter="unfiled"
        selected={selected}
        onSelect={onSelect}
        onReorderDrop={() => {}}
        isInsertBefore={false}
        editingId={editingId}
        editName={editName}
        setEditName={setEditName}
        commitRename={commitRename}
        editKey={editKey}
      />
      {folders.map((f) => (
        <FolderRow
          key={f.id}
          label={f.name || 'Untitled'}
          zone={{ folder: f.id }}
          filter={f.id}
          folder={f}
          selected={selected}
          onSelect={onSelect}
          onReorderDrop={handleFolderReorderDrop}
          onContextMenuRequest={(folderId, x, y) =>
            setCtxMenu({ x, y, folderId })
          }
          onRenameClick={onRenameClick}
          onDeleteClick={onDeleteClick}
          isInsertBefore={isReorderingFolder && insertBeforeId === f.id}
          editingId={editingId}
          editName={editName}
          setEditName={setEditName}
          commitRename={commitRename}
          editKey={editKey}
        />
      ))}
      {/* Tail "drop after last" affordance — only visible while reordering. */}
      {isReorderingFolder && insertBeforeId === 'tail' && (
        <div
          className="h-0.5 mx-2 rounded"
          style={{ background: accent(0.8) }}
          aria-hidden
        />
      )}
      {creating && (
        <div className="px-3 py-1.5">
          <input
            ref={draftInputRef}
            value={draftName}
            onChange={(e) => setDraftName(e.currentTarget.value)}
            onBlur={() => void commitCreate()}
            onKeyDown={draftKey}
            placeholder="Folder name"
            className="w-full bg-transparent outline-none t-primary text-meta border-b hair pb-0.5"
            aria-label="New folder name"
          />
        </div>
      )}
      {(() => {
        const target = ctxMenu ? folders.find((f) => f.id === ctxMenu.folderId) : null;
        if (!ctxMenu || !target) return null;
        const items: ContextMenuItem[] = [
          {
            kind: 'action',
            label: 'Rename',
            onSelect: () => onRenameClick(target),
          },
          { kind: 'separator' },
          {
            kind: 'action',
            label: 'Delete',
            tone: 'danger',
            onSelect: () => onDeleteClick(target.id),
          },
        ];
        return (
          <ContextMenu
            open
            x={ctxMenu.x}
            y={ctxMenu.y}
            items={items}
            onClose={() => setCtxMenu(null)}
            label={`Actions for folder ${target.name}`}
          />
        );
      })()}
      <ConfirmDialog
        open={deleteConfirm.open}
        title="Delete this folder?"
        description="The folder will be removed; notes inside it become unfiled."
        confirmLabel="Delete"
        tone="danger"
        suppressibleLabel="Don't ask again"
        onConfirm={(suppress) => deleteConfirm.confirm(!!suppress)}
        onCancel={deleteConfirm.cancel}
      />
    </div>
  );
};
