import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Button } from '../../shared/ui/Button';
import { SearchInput } from '../../shared/ui/SearchInput';
import { IconButton } from '../../shared/ui/IconButton';
import { Separator } from '../../shared/ui/Separator';
import { Tooltip } from '../../shared/ui/Tooltip';
import { SegmentedControl } from '../../shared/ui/SegmentedControl';
import {
  CopyIcon,
  DownloadIcon,
  ExternalIcon,
  EyeIcon,
  MagicWandIcon,
  MicIcon,
  PanelLeftIcon,
  PencilIcon,
  PinIcon,
  SearchIcon,
  SplitViewIcon,
  TrashIcon,
  UploadIcon,
} from '../../shared/ui/icons';
import { SectionLabel } from '../../shared/ui/SectionLabel';
import { useToast } from '../../shared/ui/Toast';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { EmptyState } from '../../shared/ui/EmptyState';
import { useSuppressibleConfirm } from '../../shared/hooks/useSuppressibleConfirm';
import { copyText } from '../../shared/util/clipboard';
import { revealFile } from '../../shared/util/revealFile';
import { NoteAttachmentsPanel } from './NoteAttachmentsPanel';
import { NoteAudioStrip } from './NoteAudioStrip';
import { NoteEditor, type NotesViewMode } from './NoteEditor';
import { MarkdownPreview } from './MarkdownPreview';
import { SaveStatusPill, type SaveStatus } from './SaveStatusPill';
import { AudioRecorder, type RecordedAudio } from './AudioRecorder';
import { NoteAiBar } from './NoteAiBar';
import { useUndoableString } from './useUndoableString';
import { useAudioFileDrop } from './useAudioFileDrop';
import {
  appendAudioEmbed,
  appendImageEmbed,
  insertAudioEmbedAt,
  insertTranscriptAfterEmbed,
} from './audioEmbed';
import { toggleCheckboxAtLine } from './markdown';
import { polishTranscript } from './polish';
import { loadSettings } from '../../settings/store';
import { whisperGetActive, whisperTranscribePath } from '../whisper/api';
import {
  notesCreate,
  notesDelete,
  notesExportPath,
  notesFoldersList,
  notesGet,
  notesList,
  notesReadFile,
  notesSaveAudioBytes,
  notesSaveAudioFile,
  notesSaveImageFile,
  notesSearch,
  notesSetFolder,
  notesSetPinned,
  notesUpdate,
  notesWriteFile,
  type FolderFilter,
  type Note,
  type NoteFolder,
  type NoteSummary,
} from './api';
import { FoldersSidebar } from './FoldersSidebar';
import { ContextMenu, type ContextMenuItem } from '../../shared/ui/ContextMenu';
import { usePointerDrag, type DropTargetData, type DragInfo } from './notesDnd';

const RailButton = ({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: ReactNode;
}) => (
  <IconButton onClick={onClick} title={title} tooltipSide="right">
    {children}
  </IconButton>
);

const iso = (ts: number) => {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
};

const countWords = (text: string): number => {
  // Match any run of word characters, Ukrainian/Latin/digits alike. Cheaper
  // and Unicode-aware than splitting on whitespace and trimming markdown.
  const matches = text.match(/[\p{L}\p{N}]+/gu);
  return matches ? matches.length : 0;
};

import { formatDuration as fmtDuration } from '../../shared/format/duration';

const formatDuration = (ms: number | null): string =>
  fmtDuration(ms, { unit: 'ms', empty: '—', includeHours: 'never' });

const AUTOSAVE_DEBOUNCE_MS = 400;
const SIDEBAR_COLLAPSED_KEY = 'stash:notes:sidebar-collapsed';
const FOLDER_FILTER_KEY = 'stash:notes:folder-filter';
const ZOOM_KEY = 'stash:notes:zoom';
/** Discrete zoom steps for ⌘+ / ⌘-. macOS-feel: ~10 % per step, capped so
 *  the editor never collapses (< 0.85) or pushes the toolbar offscreen
 *  (> 1.6). `1` is the canonical baseline. */
const ZOOM_STEPS = [0.85, 0.95, 1, 1.1, 1.25, 1.4, 1.6] as const;
const ZOOM_DEFAULT = 1;
const readZoom = (): number => {
  if (typeof window === 'undefined') return ZOOM_DEFAULT;
  try {
    const raw = window.localStorage.getItem(ZOOM_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && ZOOM_STEPS.includes(n as (typeof ZOOM_STEPS)[number])
      ? n
      : ZOOM_DEFAULT;
  } catch {
    return ZOOM_DEFAULT;
  }
};

const readFolderFilter = (): FolderFilter => {
  if (typeof window === 'undefined') return 'all';
  try {
    const raw = window.localStorage.getItem(FOLDER_FILTER_KEY);
    if (!raw || raw === 'all') return 'all';
    if (raw === 'unfiled') return 'unfiled';
    const n = Number(raw);
    return Number.isFinite(n) ? n : 'all';
  } catch {
    return 'all';
  }
};

const VIEW_MODE_OPTIONS = [
  {
    value: 'preview' as const,
    label: <span className="sr-only">Preview</span>,
    icon: <EyeIcon size={13} />,
    title: 'Preview only',
  },
  {
    value: 'edit' as const,
    label: <span className="sr-only">Edit</span>,
    icon: <PencilIcon size={13} />,
    title: 'Editor only',
  },
  {
    value: 'split' as const,
    label: <span className="sr-only">Split</span>,
    icon: <SplitViewIcon size={13} />,
    title: 'Editor + preview',
  },
];

/** Single row inside the notes side-list. Extracted so each row can hold
 *  its own pointer-DnD ref via `usePointerDrag` (hooks can't run inside
 *  the `.map(renderNoteRow)` loop directly). */
const NoteRow = ({
  n,
  active,
  onOpen,
  onDrop,
  onContextMenu,
  onTogglePin,
}: {
  n: NoteSummary;
  active: boolean;
  onOpen: () => void;
  onDrop: (target: DropTargetData | null, source: DragInfo) => void;
  onContextMenu: (x: number, y: number) => void;
  onTogglePin: () => void;
}) => {
  const { ref, isDragging } = usePointerDrag(
    { kind: 'note', id: n.id },
    onDrop,
  );
  const preview = n.preview.split('\n').find((l) => l.trim()) || 'No content';
  return (
    <div
      ref={ref}
      key={n.id}
      role="button"
      tabIndex={0}
      onClick={(e) => {
        // Pointer-DnD start steals the click when a real drag happened —
        // we still want a plain click without movement to open the note.
        if (isDragging) {
          e.preventDefault();
          return;
        }
        onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e.clientX, e.clientY);
      }}
      // Refresh-2026-04: chrome / state lives in the shared `.list-row`
      // primitive (data-attrs drive hover, active, dragging visuals). The
      // `--note` modifier swaps the active background tint for accent-fog
      // and shifts the accent left-bar to `top:8 / bottom:8` for the
      // taller row.
      data-active={active}
      data-dragging={isDragging}
      className="list-row list-row--note group mx-1.5 my-px px-2 py-[7px] ring-focus"
    >
      <div className="flex items-center gap-2">
        <span className={`text-body truncate flex-1 min-w-0 leading-tight ${active ? 't-primary font-semibold' : 't-primary font-medium'}`}>
          {n.title || <span className="t-tertiary italic">Untitled</span>}
        </span>
        <span className="shrink-0 relative inline-flex items-center justify-end w-7 h-4">
          <span
            className={`t-tertiary tabular-nums ${
              n.pinned ? 'hidden' : 'group-hover:hidden group-focus-within:hidden'
            }`}
            style={{ font: 'var(--t-time)' }}
          >
            {iso(n.updated_at)}
          </span>
          <Tooltip label={n.pinned ? 'Unpin note' : 'Pin note'}>
            <span
              role="button"
              tabIndex={0}
              data-no-drag
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  onTogglePin();
                }
              }}
              aria-label={n.pinned ? 'Unpin note' : 'Pin note'}
              aria-pressed={n.pinned}
              className={`ring-focus rounded p-0.5 t-tertiary hover:t-primary cursor-pointer ${
                n.pinned ? 'accent-fg inline-flex items-center' : 'hidden group-hover:inline-flex group-focus-within:inline-flex items-center'
              }`}
            >
              <PinIcon size={11} filled={n.pinned} />
            </span>
          </Tooltip>
        </span>
      </div>
      <div className="t-tertiary text-meta truncate mt-0.5">{preview}</div>
    </div>
  );
};

export const NotesShell = () => {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  // Full note for the currently active row — loaded on demand from Rust so
  // the list itself can stay on summaries. AudioNoteView reads from here too.
  const [activeNote, setActiveNote] = useState<Note | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState('');
  const {
    value: body,
    setValue: setBody,
    reset: resetBody,
    undo: undoBody,
    redo: redoBody,
    beginTransaction: beginBodyTransaction,
    endTransaction: endBodyTransaction,
    canUndo,
    canRedo,
  } = useUndoableString('');
  const [viewMode, setViewMode] = useState<NotesViewMode>('preview');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const saveTimer = useRef<number | null>(null);
  const savedClearTimer = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  /// Guards against duplicate `notesCreate` when the initial save round-trip
  /// is slower than the debounce window — a pending create sets this to the
  /// in-flight promise so later saves wait for `activeId` to land.
  const pendingCreateRef = useRef<Promise<number> | null>(null);
  const [recorderOpen, setRecorderOpen] = useState(false);
  const [aiBarOpen, setAiBarOpenState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage?.getItem('stash:notes:ai-bar-open') === '1';
    } catch {
      return false;
    }
  });
  const setAiBarOpen = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setAiBarOpenState((prev) => {
      const value = typeof next === 'function' ? next(prev) : next;
      try {
        window.localStorage.setItem('stash:notes:ai-bar-open', value ? '1' : '0');
      } catch {
        /* ignore */
      }
      return value;
    });
  }, []);
  /// Intent the recorder was opened with. `new` always creates a fresh note
  /// around the embed (sidebar mic button), `current` appends into whatever
  /// note is active (toolbar mic button). A ref — not state — because it
  /// only needs to round-trip from the button click to `onRecorderComplete`,
  /// and a re-render on mere intent change is pointless.
  const recorderIntentRef = useRef<'current' | 'new'>('current');
  /// Monotonic session id for in-flight transcription. Each new run bumps
  /// this; the in-flight promise bails out if its session is no longer
  /// current. Also drives the SaveStatusPill cancel affordance — Whisper
  /// itself still runs to completion in Rust, but the UI forgets about
  /// the result so the user isn't blocked.
  const transcribeSessionRef = useRef(0);
  const [folderFilter, setFolderFilterState] = useState<FolderFilter>(readFolderFilter);
  const setFolderFilter = useCallback((next: FolderFilter) => {
    setFolderFilterState(next);
    try {
      window.localStorage.setItem(FOLDER_FILTER_KEY, String(next));
    } catch {
      // ignore
    }
  }, []);
  const [sidebarCollapsed, setSidebarCollapsedState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage?.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [notesZoom, setNotesZoomState] = useState<number>(readZoom);
  const setNotesZoom = useCallback((next: number) => {
    setNotesZoomState(next);
    try {
      window.localStorage.setItem(ZOOM_KEY, String(next));
    } catch {
      /* ignore */
    }
  }, []);
  const { toast } = useToast();

  const setSidebarCollapsed = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setSidebarCollapsedState((prev) => {
      const value = typeof next === 'function' ? next(prev) : next;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, value ? '1' : '0');
      } catch {
        // ignore storage failures (private mode, quota, etc.)
      }
      return value;
    });
  }, []);

  const expandSidebarAndFocusSearch = useCallback(() => {
    setSidebarCollapsed(false);
    window.setTimeout(() => searchRef.current?.focus(), 0);
  }, [setSidebarCollapsed]);

  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      if (savedClearTimer.current !== null) window.clearTimeout(savedClearTimer.current);
    },
    [],
  );

  const reload = useCallback(async () => {
    const data = query.trim()
      ? await notesSearch(query, folderFilter)
      : await notesList(folderFilter);
    setNotes(data);
    return data;
  }, [query, folderFilter]);

  const assignNoteToFolder = useCallback(
    async (noteId: number, folderId: number | null, folderLabel: string) => {
      // Skip the no-op when the user drops a note onto its current folder —
      // avoids a useless toast and a wasted IPC round-trip.
      const current = notes.find((n) => n.id === noteId);
      if (current && (current.folder_id ?? null) === folderId) return;
      try {
        await notesSetFolder(noteId, folderId);
        setFolderFilter(folderId == null ? 'unfiled' : folderId);
        await reload();
        toast({
          title: `Moved to ${folderLabel}`,
          variant: 'success',
          durationMs: 1500,
        });
      } catch (e) {
        toast({ title: 'Move failed', description: String(e), variant: 'error' });
      }
    },
    [notes, reload, setFolderFilter, toast]
  );

  const togglePinned = useCallback(
    async (id: number, pinned: boolean) => {
      try {
        await notesSetPinned(id, pinned);
        await reload();
        // Optimistically reflect on the loaded full note too, so the header
        // pin state flips without waiting for the next notesGet round-trip.
        setActiveNote((prev) => (prev && prev.id === id ? { ...prev, pinned } : prev));
      } catch (e) {
        toast({ title: 'Pin failed', description: String(e), variant: 'error' });
      }
    },
    [reload, toast],
  );

  // Folders are also fetched here (independently from FoldersSidebar) so the
  // note row context menu can show a "Move to" submenu without prop drilling.
  // Both fetches react to the shared `notes:changed` event below.
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  /// Per-folder note counts driving the badges in the folders sidebar.
  /// Computed from a `notesList('all')` fetch (separate from the main
  /// filtered list so counts stay correct even when the user filters
  /// the side-list to a single folder). Refreshed on mount + every
  /// `notes:changed` event. Cheap — at 500 notes the response is ~150 KB.
  const [folderCounts, setFolderCounts] = useState<{
    total: number;
    unfiled: number;
    byFolder: Record<number, number>;
  }>({ total: 0, unfiled: 0, byFolder: {} });
  const refreshFolderCounts = useCallback(async () => {
    try {
      const all = await notesList('all');
      const byFolder: Record<number, number> = {};
      let unfiled = 0;
      for (const n of all) {
        if (n.folder_id == null) unfiled += 1;
        else byFolder[n.folder_id] = (byFolder[n.folder_id] ?? 0) + 1;
      }
      setFolderCounts({ total: all.length, unfiled, byFolder });
    } catch {
      // Counts are decoration — fail silently; the sidebar still works.
    }
  }, []);
  useEffect(() => {
    void notesFoldersList()
      .then((list) => setFolders(Array.isArray(list) ? list : []))
      .catch(() => {});
    void refreshFolderCounts();
  }, [refreshFolderCounts]);
  const [noteCtxMenu, setNoteCtxMenu] = useState<
    { x: number; y: number; noteId: number } | null
  >(null);

  const { pinned: pinnedNotes, recent: recentNotes } = useMemo(
    () => ({
      pinned: notes.filter((n) => n.pinned),
      recent: notes.filter((n) => !n.pinned),
    }),
    [notes],
  );

  useEffect(() => {
    reload().then((data) => {
      if (activeId == null && data.length > 0) {
        setActiveId(data[0].id);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, folderFilter]);

  // Cross-module inserts (e.g. Telegram /note) fire `notes:changed` so the
  // sidebar refreshes without the user re-typing in the search box.
  // Hold `reload` in a ref so the listener is registered exactly once on
  // mount — re-subscribing on every `query` change can drop events that
  // arrive between unsubscribe and re-subscribe.
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);
  useEffect(() => {
    let cancel: (() => void) | undefined;
    listen('notes:changed', () => {
      void reloadRef.current();
      void notesFoldersList()
        .then((list) => setFolders(Array.isArray(list) ? list : []))
        .catch(() => {});
      void refreshFolderCounts();
    }).then((un) => {
      cancel = un;
    });
    return () => {
      cancel?.();
    };
  }, [refreshFolderCounts]);

  const active = activeNote;

  // Load the full body on activation — the side-list only carries summaries,
  // so opening Notes ships at most ~150 KB across IPC even with 500 entries.
  useEffect(() => {
    if (activeId == null) {
      setActiveNote(null);
      setTitle('');
      resetBody('');
      return;
    }
    let cancelled = false;
    void notesGet(activeId).then((note) => {
      if (cancelled || !note) return;
      setActiveNote(note);
      setTitle(note.title);
      // Fresh history per note — undo shouldn't cross notes.
      resetBody(note.body);
    });
    return () => {
      cancelled = true;
    };
  }, [activeId]);
  // intentionally not depending on `notes` / edits — the user's in-progress
  // edits live in `title` / `body`; we only refetch when switching rows.

  const scheduleSave = useCallback(
    (nextTitle: string, nextBody: string) => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      if (savedClearTimer.current) window.clearTimeout(savedClearTimer.current);
      setSaveStatus('saving');
      saveTimer.current = window.setTimeout(async () => {
        try {
          let targetId = activeId;
          if (targetId == null) {
            // If an initial create is already in flight, await its id instead
            // of issuing a second `notesCreate` that would produce a duplicate.
            if (pendingCreateRef.current) {
              targetId = await pendingCreateRef.current;
            } else {
              if (!nextTitle && !nextBody) {
                setSaveStatus('idle');
                return;
              }
              const p = notesCreate(nextTitle, nextBody);
              pendingCreateRef.current = p;
              try {
                targetId = await p;
                setActiveId(targetId);
              } finally {
                pendingCreateRef.current = null;
              }
              // The create already persisted `nextTitle`/`nextBody`, no update
              // needed on this tick.
              reload();
              setSaveStatus('saved');
              savedClearTimer.current = window.setTimeout(() => setSaveStatus('idle'), 1800);
              return;
            }
          }
          await notesUpdate(targetId, nextTitle, nextBody);
          reload();
          setSaveStatus('saved');
          savedClearTimer.current = window.setTimeout(() => setSaveStatus('idle'), 1800);
        } catch (e) {
          console.error('notes save failed', e);
          setSaveStatus('error');
        }
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [activeId, reload]
  );

  const onTitleChange = (v: string) => {
    setTitle(v);
    scheduleSave(v, body);
  };

  const onBodyChange = (v: string) => {
    setBody(v);
    scheduleSave(title, v);
  };

  const handleUndo = useCallback(() => {
    const prev = undoBody();
    if (prev !== undefined) scheduleSave(title, prev);
  }, [scheduleSave, title, undoBody]);

  const handleRedo = useCallback(() => {
    const next = redoBody();
    if (next !== undefined) scheduleSave(title, next);
  }, [redoBody, scheduleSave, title]);

  /** Persist the current title/body and export a stable on-disk `.md`
   *  copy, returning its absolute path. Flushes any pending debounced
   *  save first so the export reflects the latest edits instead of a
   *  stale DB snapshot. */
  const exportCurrentNotePath = useCallback(async (): Promise<string | null> => {
    if (activeId == null) return null;
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    await notesUpdate(activeId, title, body);
    return notesExportPath(activeId);
  }, [activeId, body, title]);

  const revealNoteFile = useCallback(async () => {
    try {
      const path = await exportCurrentNotePath();
      if (!path) return;
      await revealFile(path);
    } catch (e) {
      toast({
        title: 'Reveal failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      });
    }
  }, [exportCurrentNotePath, toast]);

  const copyNotePath = useCallback(async () => {
    try {
      const path = await exportCurrentNotePath();
      if (!path) return;
      const ok = await copyText(path);
      if (ok) {
        toast({
          title: 'Path copied',
          description: path,
          variant: 'success',
          durationMs: 2200,
        });
      } else {
        toast({ title: 'Copy failed', variant: 'error' });
      }
    } catch (e) {
      toast({
        title: 'Export failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      });
    }
  }, [exportCurrentNotePath, toast]);

  /** Same as `exportCurrentNotePath` but for any note id. Flushes the
   *  pending debounced save only when the requested note is the one being
   *  edited — other notes never have unsaved edits so a direct export is
   *  safe and avoids a wasted `notesUpdate` round-trip. */
  const exportNotePath = useCallback(
    async (noteId: number): Promise<string | null> => {
      if (noteId === activeId) return exportCurrentNotePath();
      return notesExportPath(noteId);
    },
    [activeId, exportCurrentNotePath]
  );

  const revealNoteById = useCallback(
    async (noteId: number) => {
      try {
        const path = await exportNotePath(noteId);
        if (!path) return;
        await revealFile(path);
      } catch (e) {
        toast({
          title: 'Reveal failed',
          description: e instanceof Error ? e.message : String(e),
          variant: 'error',
        });
      }
    },
    [exportNotePath, toast]
  );

  const copyNotePathById = useCallback(
    async (noteId: number) => {
      try {
        const path = await exportNotePath(noteId);
        if (!path) return;
        const ok = await copyText(path);
        toast(
          ok
            ? { title: 'Path copied', description: path, variant: 'success', durationMs: 2200 }
            : { title: 'Copy failed', variant: 'error' }
        );
      } catch (e) {
        toast({
          title: 'Export failed',
          description: e instanceof Error ? e.message : String(e),
          variant: 'error',
        });
      }
    },
    [exportNotePath, toast]
  );

  const onToggleCheckbox = useCallback(
    (line: number) => {
      const next = toggleCheckboxAtLine(body, line);
      if (next !== body) {
        setBody(next);
        scheduleSave(title, next);
      }
    },
    [body, title, scheduleSave]
  );

  const newNote = async () => {
    const id = await notesCreate('', '');
    // If a folder is currently selected, drop the new note into it so it
    // shows up in the active filter immediately. `'unfiled'` and `'all'`
    // already match a fresh note (folder_id IS NULL), so no extra call.
    if (typeof folderFilter === 'number') {
      try {
        await notesSetFolder(id, folderFilter);
      } catch (e) {
        console.error('assign new note to folder failed', e);
      }
    }
    setActiveId(id);
    // Brand-new blank note — drop the user straight into the editor instead of
    // the empty preview pane. Existing notes open in preview (see row onClick).
    setViewMode('edit');
    await reload();
  };

  // ⌘D inside the Notes tab forks the active note. Skipped while typing in
  // the title input or markdown editor so the user can still type "d" with
  // a stuck Cmd modifier; routed through `e.target` instead of focus
  // because the editor textarea may briefly lose focus during AI streams.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;
      if (e.key !== 'd' && e.key !== 'D') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (activeId == null) return;
      e.preventDefault();
      void duplicateNote(activeId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  /** ⌘+ / ⌘- / ⌘0 — zoom the editor + preview typography. Active in the
   *  Notes tab regardless of focus target (textarea included), so the
   *  shortcut keeps working while typing. `=` matches the unshifted form
   *  of the `+` key on most layouts so users don't need to hold Shift. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      const key = e.key;
      const isPlus = key === '+' || key === '=';
      const isMinus = key === '-' || key === '_';
      const isZero = key === '0';
      if (!isPlus && !isMinus && !isZero) return;
      e.preventDefault();
      if (isZero) {
        setNotesZoom(ZOOM_DEFAULT);
        return;
      }
      const idx = ZOOM_STEPS.indexOf(notesZoom as (typeof ZOOM_STEPS)[number]);
      // If somehow stuck off-grid (e.g. older value), snap to nearest known step.
      const baseIdx = idx >= 0 ? idx : ZOOM_STEPS.indexOf(ZOOM_DEFAULT);
      const nextIdx = isPlus
        ? Math.min(ZOOM_STEPS.length - 1, baseIdx + 1)
        : Math.max(0, baseIdx - 1);
      const next = ZOOM_STEPS[nextIdx];
      if (next !== notesZoom) setNotesZoom(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [notesZoom, setNotesZoom]);

  /** Fork a note into a new one. Copies title (with a "copy" suffix) and
   *  body verbatim, then mirrors the source folder so the duplicate sits
   *  next to its origin in the side-list. The new note becomes active so
   *  the user can start editing immediately. Audio attachments aren't
   *  carried over — voice recordings are tied to the original note's
   *  recording id; cloning them would create dangling references. */
  const duplicateNote = useCallback(
    async (sourceId: number) => {
      try {
        const src = await notesGet(sourceId);
        if (!src) return;
        // Suffix the title once. If the title already ends with " copy"
        // we still append — `" copy 2"` semantics aren't worth the parsing
        // complexity, and the user can rename freely.
        const nextTitle = src.title.trim() ? `${src.title} copy` : 'Untitled copy';
        const newId = await notesCreate(nextTitle, src.body);
        if (src.folder_id != null) {
          await notesSetFolder(newId, src.folder_id);
        }
        setActiveId(newId);
        setViewMode('edit');
        await reload();
        toast({
          title: 'Note duplicated',
          description: nextTitle,
          variant: 'success',
          durationMs: 1800,
        });
      } catch (e) {
        toast({
          title: 'Duplicate failed',
          description: e instanceof Error ? e.message : String(e),
          variant: 'error',
        });
      }
    },
    [reload, toast],
  );

  const openRecorderForNew = useCallback(() => {
    recorderIntentRef.current = 'new';
    setRecorderOpen(true);
  }, []);
  const openRecorderForCurrent = useCallback(() => {
    recorderIntentRef.current = 'current';
    setRecorderOpen(true);
  }, []);

  /** Resolve the target note for a new inline audio embed.
   *
   *  `intent: 'current'` reuses the active note so recordings/drops
   *  accumulate in one place alongside whatever text the user is writing.
   *  Falls back to creating a blank note when nothing is active.
   *
   *  `intent: 'new'` always creates a fresh note — the sidebar mic button
   *  wants every click to produce a new voice note, even when another note
   *  happens to be open. */
  const resolveEmbedTarget = useCallback(
    async (intent: 'current' | 'new' = 'current'): Promise<{
      id: number;
      title: string;
      body: string;
      isNew: boolean;
    }> => {
      if (intent === 'current' && activeNote && activeId != null) {
        return { id: activeId, title, body, isNew: false };
      }
      const id = await notesCreate('', '');
      return { id, title: '', body: '', isNew: true };
    },
    [activeId, activeNote, body, title]
  );

  /** Write `nextBody` into the target note, keeping local state in sync so
   *  the editor / preview reflect the new embed immediately without
   *  waiting for the notesGet round-trip. */
  const commitBodyUpdate = useCallback(
    async (target: { id: number; title: string }, nextBody: string) => {
      await notesUpdate(target.id, target.title, nextBody);
      setActiveId(target.id);
      setTitle(target.title);
      setBody(nextBody);
      setActiveNote((prev) =>
        prev && prev.id === target.id ? { ...prev, body: nextBody } : prev
      );
      await reload();
    },
    [reload]
  );

  /** Transcribe a just-embedded audio file and splice the transcript into
   *  the note's body right after the `![caption](path)` reference. Reads
   *  the latest body via `setBody(prev => …)` so a user editing during
   *  transcription doesn't get their changes clobbered. */
  const runInlineTranscribe = useCallback(
    async (noteId: number, path: string) => {
      const settings = await loadSettings().catch(() => null);
      if (!settings?.notesAutoTranscribe) return;
      const model = await whisperGetActive().catch(() => null);
      if (!model) return;
      const session = ++transcribeSessionRef.current;
      const cancelled = () => transcribeSessionRef.current !== session;
      setSaveStatus('transcribing');
      toast({ title: 'Transcribing voice note…', variant: 'default', durationMs: 2200 });
      let transcript: string;
      try {
        transcript = await whisperTranscribePath(path, 'uk');
      } catch (e) {
        if (cancelled()) return;
        setSaveStatus('error');
        toast({
          title: 'Auto-transcribe failed',
          description: String(e),
          variant: 'error',
          action: { label: 'Retry', onClick: () => void runInlineTranscribe(noteId, path) },
        });
        return;
      }
      if (cancelled()) return;
      // Functional setState reads the freshest body, so concurrent typing
      // between the embed-insert and transcription return is preserved.
      let persisted: string | null = null;
      setBody((prev) => {
        const next = insertTranscriptAfterEmbed(prev, path, transcript);
        persisted = next;
        return next;
      });
      if (persisted !== null) {
        await notesUpdate(noteId, title, persisted);
        setActiveNote((p) => (p && p.id === noteId ? { ...p, body: persisted! } : p));
        await reload();
      }
      setSaveStatus('saved');
      if (savedClearTimer.current !== null) window.clearTimeout(savedClearTimer.current);
      savedClearTimer.current = window.setTimeout(() => setSaveStatus('idle'), 1800);
      toast({ title: 'Transcribed', variant: 'success', durationMs: 2000 });

      if (!settings.notesAutoPolish || !transcript.trim()) return;
      setSaveStatus('polishing');
      toast({ title: 'Polishing transcript…', variant: 'default', durationMs: 2200 });
      try {
        const polish = await polishTranscript(transcript, {
          aiProvider: settings.aiProvider,
          aiModel: settings.aiModel,
          aiBaseUrl: settings.aiBaseUrl,
          aiSystemPrompt: settings.aiSystemPrompt,
          aiApiKeys: settings.aiApiKeys,
        });
        if (cancelled()) return;
        if (polish.kind !== 'ok') {
          setSaveStatus('idle');
          return;
        }
        let polished: string | null = null;
        setBody((prev) => {
          // Replace the raw transcript block with the polished version by
          // first removing the raw (via transcript match) and re-inserting.
          const withoutRaw = prev.replace(transcript.trim(), '').replace(/\n{3,}/g, '\n\n');
          const next = insertTranscriptAfterEmbed(withoutRaw, path, polish.text);
          polished = next;
          return next;
        });
        if (polished !== null) {
          await notesUpdate(noteId, title, polished);
          setActiveNote((p) => (p && p.id === noteId ? { ...p, body: polished! } : p));
          await reload();
        }
        setSaveStatus('saved');
        if (savedClearTimer.current !== null) window.clearTimeout(savedClearTimer.current);
        savedClearTimer.current = window.setTimeout(() => setSaveStatus('idle'), 1800);
        toast({ title: 'Polished', variant: 'success', durationMs: 2000 });
      } catch (e) {
        if (cancelled()) return;
        setSaveStatus('error');
        toast({ title: 'Auto-polish failed', description: String(e), variant: 'error' });
      }
    },
    [reload, title, toast]
  );

  /** Cancel whatever transcription/polish is currently in flight. Whisper
   *  itself keeps churning on the Rust side — there's no cheap abort path
   *  through `whisper.cpp` — so we just bump the session id and let the
   *  arriving result drop on the floor, freeing the UI immediately. */
  const cancelTranscribe = useCallback(() => {
    transcribeSessionRef.current += 1;
    setSaveStatus('idle');
    toast({ title: 'Transcription cancelled', variant: 'default', durationMs: 1400 });
  }, [toast]);

  const onRecorderComplete = useCallback(
    async (audio: RecordedAudio) => {
      setRecorderOpen(false);
      let savedPath: string;
      try {
        savedPath = await notesSaveAudioBytes(audio.bytes, audio.ext);
      } catch (e) {
        console.error('voice note save failed', e);
        toast({ title: 'Couldn\u2019t save recording', description: String(e), variant: 'error' });
        return;
      }
      const target = await resolveEmbedTarget(recorderIntentRef.current);
      // Insert at cursor when the editor is focused on the current note, so
      // a quick ⌘⇧R in the middle of typing lands the embed where the user
      // was writing. Otherwise append as a new block at the end.
      const editor = editorRef.current;
      const atCursor =
        !target.isNew && editor && document.activeElement === editor;
      const caption = `voice note · ${new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })}`;
      let nextBody: string;
      let nextCursor: number | null = null;
      if (atCursor && editor) {
        const pos = editor.selectionStart ?? target.body.length;
        const r = insertAudioEmbedAt(target.body, pos, savedPath, caption);
        nextBody = r.body;
        nextCursor = r.cursor;
      } else {
        nextBody = appendAudioEmbed(target.body, savedPath, caption);
      }
      await commitBodyUpdate(target, nextBody);
      if (nextCursor != null && editor) {
        window.requestAnimationFrame(() => {
          editor.focus();
          editor.setSelectionRange(nextCursor!, nextCursor!);
        });
      }
      toast({
        title: 'Voice note embedded',
        description: formatDuration(audio.durationMs),
        variant: 'success',
        durationMs: 1600,
      });
      await runInlineTranscribe(target.id, savedPath);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resolveEmbedTarget, commitBodyUpdate, toast]
  );

  const deleteConfirm = useSuppressibleConfirm<number>('notes.delete');

  const performDelete = useCallback(
    async (id: number) => {
      await notesDelete(id);
      setActiveId(null);
      setTitle('');
      resetBody('');
      await reload();
    },
    [reload]
  );

  const removeActive = () => {
    if (activeId == null) return;
    deleteConfirm.request(activeId, performDelete);
  };

  /** Drop handler: every dropped media file becomes an inline
   *  `![caption](path)` embed inside the active note, so audios and images
   *  share one note alongside any text the user is writing. We resolve the
   *  target once and reuse it across the whole batch so a four-file drop
   *  doesn't spawn four new notes. Auto-transcription runs serially after
   *  all audio files land; images skip that path entirely. */
  const onAudioFilesDropped = useCallback(
    async (paths: { audio: string[]; image: string[] }) => {
      const total = paths.audio.length + paths.image.length;
      if (total === 0) return;
      const kindLabel =
        paths.audio.length > 0 && paths.image.length > 0
          ? `${total} files`
          : paths.audio.length > 0
            ? paths.audio.length === 1
              ? 'audio'
              : `${paths.audio.length} audio files`
            : paths.image.length === 1
              ? 'image'
              : `${paths.image.length} images`;
      toast({ title: `Importing ${kindLabel}…`, variant: 'default', durationMs: 1400 });

      let target = await resolveEmbedTarget();
      const savedAudio: string[] = [];
      let savedImages = 0;

      for (const p of paths.image) {
        try {
          const saved = await notesSaveImageFile(p);
          const caption = (p.split(/[\\/]/).pop() ?? 'image').replace(/\.[^.]+$/, '');
          const nextBody = appendImageEmbed(target.body, saved, caption);
          await commitBodyUpdate(target, nextBody);
          target = { ...target, body: nextBody, isNew: false };
          savedImages += 1;
        } catch (e) {
          console.error('image import failed', p, e);
          toast({
            title: 'Image import failed',
            description: `${p.split(/[\\/]/).pop() ?? p}: ${String(e)}`,
            variant: 'error',
          });
        }
      }

      for (const p of paths.audio) {
        try {
          const saved = await notesSaveAudioFile(p);
          const caption = (p.split(/[\\/]/).pop() ?? 'audio').replace(/\.[^.]+$/, '');
          const nextBody = appendAudioEmbed(target.body, saved, caption);
          await commitBodyUpdate(target, nextBody);
          target = { ...target, body: nextBody, isNew: false };
          savedAudio.push(saved);
        } catch (e) {
          console.error('audio import failed', p, e);
          toast({
            title: 'Audio import failed',
            description: `${p.split(/[\\/]/).pop() ?? p}: ${String(e)}`,
            variant: 'error',
          });
        }
      }

      const embedded = savedAudio.length + savedImages;
      if (embedded > 0) {
        setActiveId(target.id);
        setViewMode('preview');
        toast({
          title: embedded === 1 ? 'Embedded' : `${embedded} files embedded`,
          variant: 'success',
          durationMs: 1800,
        });
        for (const savedPath of savedAudio) {
          await runInlineTranscribe(target.id, savedPath);
        }
      }
    },
    [resolveEmbedTarget, commitBodyUpdate, runInlineTranscribe, toast]
  );

  const { isDragOver, audioCount, imageCount } = useAudioFileDrop(onAudioFilesDropped);

  const onImport = useCallback(async () => {
    // Suspend popup auto-hide so focus shifting to the native file picker
    // does not blur-dismiss the popup and immediately close the dialog.
    await invoke('set_popup_auto_hide', { enabled: false }).catch(() => {});
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
      });
      if (!picked || typeof picked !== 'string') return;
      const result = await notesReadFile(picked);
      const id = await notesCreate(result.name, result.contents);
      setActiveId(id);
      await reload();
      toast({ title: 'Imported', description: result.name, variant: 'success' });
    } catch (e) {
      console.error('import failed', e);
      toast({ title: 'Import failed', description: String(e), variant: 'error' });
    } finally {
      await invoke('set_popup_auto_hide', { enabled: true }).catch(() => {});
    }
  }, [reload, toast]);

  const onExport = useCallback(async () => {
    await invoke('set_popup_auto_hide', { enabled: false }).catch(() => {});
    try {
      const defaultName = (title.trim() || 'note').replace(/[\\/:*?"<>|]/g, '-');
      const picked = await saveDialog({
        defaultPath: `${defaultName}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (!picked) return;
      const contents = title.trim() ? `# ${title.trim()}\n\n${body}` : body;
      await notesWriteFile(picked, contents);
      toast({ title: 'Exported', description: picked, variant: 'success' });
    } catch (e) {
      console.error('export failed', e);
      toast({ title: 'Export failed', description: String(e), variant: 'error' });
    } finally {
      await invoke('set_popup_auto_hide', { enabled: true }).catch(() => {});
    }
  }, [title, body, toast]);

  const isEditing = active || (activeId === null && (title || body));
  const exportDisabled = !body && !title;
  const showEditor = viewMode !== 'preview';
  const showPreview = viewMode !== 'edit';

  const handleNoteDrop = useCallback(
    async (target: DropTargetData | null, source: DragInfo) => {
      if (source.kind !== 'note') return;
      if (!target || target.kind !== 'note-into') return;
      await assignNoteToFolder(source.id, target.folderId, target.label);
    },
    [assignNoteToFolder],
  );

  const renderNoteRow = (n: NoteSummary) => (
    <NoteRow
      key={n.id}
      n={n}
      active={n.id === activeId}
      onOpen={() => {
        setActiveId(n.id);
        setViewMode('preview');
      }}
      onDrop={handleNoteDrop}
      onContextMenu={(x, y) => setNoteCtxMenu({ x, y, noteId: n.id })}
      onTogglePin={() => void togglePinned(n.id, !n.pinned)}
    />
  );

  return (
    <div className="h-full flex relative">
      {isDragOver && (
        <div
          className="absolute inset-0 z-40 pointer-events-none flex flex-col items-center justify-center gap-2.5"
          role="presentation"
          data-testid="notes-audio-drop-overlay"
          style={{
            // Refresh-2026-04: full-pane accent-fog fill, 1.5 px dashed
            // accent border. Centre stack: 64 px accent ring with halo +
            // 16 px H3 + 12 px description. Replaces the prior glass-card
            // floating in the middle.
            background: 'var(--accent-fog)',
            backdropFilter: 'blur(2px)',
            WebkitBackdropFilter: 'blur(2px)',
            border: `1.5px dashed rgb(var(--stash-accent-rgb))`,
          }}
        >
          <div
            className="flex items-center justify-center"
            style={{
              width: 64,
              height: 64,
              borderRadius: '50%',
              background: 'rgb(var(--stash-accent-rgb))',
              color: 'var(--accent-fg)',
              boxShadow:
                '0 0 0 8px var(--accent-soft), 0 0 0 16px var(--accent-fog)',
            }}
          >
            <MicIcon size={22} />
          </div>
          <div className="t-primary" style={{ font: 'var(--t-h2)' }}>
            {(() => {
              const total = audioCount + imageCount;
              const parts: string[] = [];
              if (audioCount > 0)
                parts.push(audioCount === 1 ? 'audio file' : `${audioCount} audio files`);
              if (imageCount > 0)
                parts.push(imageCount === 1 ? 'image' : `${imageCount} images`);
              if (total === 0) return 'Drop media to import';
              return `Drop ${parts.join(' + ')} to import`;
            })()}
          </div>
          <div className="t-secondary text-meta">
            {audioCount > 0
              ? 'Audio is auto-transcribed after the drop'
              : 'Files embed into the active note'}
          </div>
        </div>
      )}
      <aside
        className="relative shrink-0 overflow-hidden transition-[width] duration-200 ease-out"
        style={{
          width: sidebarCollapsed ? 'var(--rail-w)' : 'var(--sidebar-w)',
          background: 'var(--bg-sidebar)',
          borderRight: '0.5px solid var(--hairline)',
        }}
      >
        <div
          className={`absolute inset-y-0 left-0 flex flex-col items-center py-2 gap-1 transition-opacity duration-150 ${
            sidebarCollapsed ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          style={{ width: 'var(--rail-w)' }}
          aria-hidden={!sidebarCollapsed}
        >
          <RailButton onClick={() => setSidebarCollapsed(false)} title="Expand notes list">
            <PanelLeftIcon size={14} />
          </RailButton>
          <RailButton onClick={newNote} title="New note (⌘N)">
            <PencilIcon size={13} />
          </RailButton>
          <RailButton onClick={openRecorderForNew} title="New voice note">
            <MicIcon size={13} />
          </RailButton>
          <RailButton onClick={expandSidebarAndFocusSearch} title="Search notes">
            <SearchIcon size={13} />
          </RailButton>
          <div className="flex-1" />
          <RailButton onClick={onImport} title="Import .md">
            <UploadIcon size={13} />
          </RailButton>
        </div>
        <div
          className={`absolute inset-y-0 left-0 flex flex-col overflow-x-hidden transition-opacity duration-150 ${
            sidebarCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'
          }`}
          style={{ width: 'var(--sidebar-w)' }}
          aria-hidden={sidebarCollapsed}
        >
        <div className="px-2 pt-2 pb-1 flex items-center gap-1.5">
          <div className="flex-1 min-w-0">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Search notes"
              inputRef={searchRef}
              compact
              variant="surface"
            />
          </div>
          <IconButton
            onClick={() => setSidebarCollapsed(true)}
            title="Collapse notes list"
          >
            <PanelLeftIcon size={13} />
          </IconButton>
        </div>
        <div className="px-2 pt-0.5 pb-2 grid gap-1.5" style={{ gridTemplateColumns: '1fr 28px' }}>
          <Button
            variant="solid"
            tone="accent"
            size="md"
            onClick={newNote}
            title="New note (⌘N)"
            aria-label="New note"
            fullWidth
            leadingIcon={<PencilIcon size={12} />}
          >
            New note
          </Button>
          <Button
            variant="ghost"
            tone="neutral"
            size="md"
            shape="square"
            onClick={openRecorderForNew}
            title="New voice note"
            aria-label="New voice note"
            className="!h-7 !w-7 [background:var(--bg-elev)] [border:0.5px_solid_var(--hairline-strong)]"
          >
            <MicIcon size={13} />
          </Button>
        </div>
        <div
          className="shrink-0 overflow-y-auto overflow-x-hidden nice-scroll"
          style={{
            maxHeight: '30%',
            borderBottom: '0.5px solid var(--hairline)',
          }}
        >
          <FoldersSidebar
            selected={folderFilter}
            onSelect={setFolderFilter}
            counts={folderCounts}
          />
        </div>
        <div className="flex-1 overflow-y-auto overflow-x-hidden nice-scroll pt-1">
          {pinnedNotes.length > 0 && (
            <div className="px-3 py-1">
              <SectionLabel>Pinned</SectionLabel>
            </div>
          )}
          {pinnedNotes.map((n) => renderNoteRow(n))}
          {pinnedNotes.length > 0 && recentNotes.length > 0 && (
            <div className="px-3 py-1">
              <SectionLabel>Recent</SectionLabel>
            </div>
          )}
          {recentNotes.map((n) => renderNoteRow(n))}
          {notes.length === 0 && (
            <EmptyState
              variant="compact"
              title={query ? 'No matches' : 'No notes yet'}
              description={query ? 'Try a different search.' : 'Create your first note above.'}
            />
          )}
        </div>
        <div
          className="flex items-center gap-1.5 px-2 py-1.5"
          style={{ borderTop: '0.5px solid var(--hairline)' }}
        >
          <Button
            variant="ghost"
            size="sm"
            fullWidth
            onClick={onImport}
            title="Open a markdown or text file as a new note"
            leadingIcon={<UploadIcon size={11} />}
            className="!h-6 !text-meta t-tertiary hover:t-primary"
          >
            Import .md
          </Button>
        </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        {isEditing ? (
          <>
            <div
              className="flex flex-col gap-1"
              style={{
                padding: '12px 14px 6px',
                borderBottom: '0.5px solid var(--hairline)',
              }}
            >
              <div className="flex items-center gap-2">
                <input
                  value={title}
                  onChange={(e) => onTitleChange(e.currentTarget.value)}
                  placeholder="Untitled"
                  className="flex-1 bg-transparent outline-none t-primary min-w-0"
                  style={{
                    // `--t-display` composes weight 600 / 18 px / 1.25 /
                    // SF Pro Display in one declaration. Letter-spacing
                    // tightens further per the spec's note-title treatment.
                    font: 'var(--t-display)',
                    letterSpacing: '-0.01em',
                  }}
                />
                <SaveStatusPill status={saveStatus} onCancel={cancelTranscribe} />
                <SegmentedControl
                  size="sm"
                  options={VIEW_MODE_OPTIONS}
                  value={viewMode}
                  onChange={setViewMode}
                  ariaLabel="View mode"
                />
                <Separator orientation="vertical" tone="strong" className="mx-[3px]" />
                {/* Refresh-2026-04: 8 inline header actions clustered into
                 * three groups separated by 0.5 × 16 hairline-strong rules:
                 * [pin · mic · send · ai] | [reveal · copy] | [export · delete]. */}
                <div className="flex items-center shrink-0" style={{ gap: 1 }}>
                  {active && (
                    <IconButton
                      onClick={() => void togglePinned(active.id, !active.pinned)}
                      title={active.pinned ? 'Unpin note' : 'Pin note'}
                      stopPropagation={false}
                    >
                      <PinIcon
                        size={13}
                        filled={active.pinned}
                        className={active.pinned ? '' : undefined}
                      />
                    </IconButton>
                  )}
                  <IconButton
                    onClick={openRecorderForCurrent}
                    title="Record voice note into this note"
                    stopPropagation={false}
                  >
                    <MicIcon size={13} />
                  </IconButton>
                  <IconButton
                    onClick={async () => {
                      try {
                        const trimmed = body.trim();
                        if (!trimmed) {
                          toast({
                            title: 'Nothing to send',
                            description: 'Write something first.',
                            variant: 'default',
                          });
                          return;
                        }
                        const composed = title.trim()
                          ? `*${title.trim()}*\n\n${trimmed}`
                          : trimmed;
                        const sent = await invoke<boolean>('telegram_send_text', {
                          text: composed,
                        });
                        if (sent) {
                          toast({
                            title: 'Sent to Telegram',
                            variant: 'success',
                            durationMs: 1500,
                          });
                        } else {
                          toast({
                            title: 'Pair Telegram first',
                            description: 'Settings → Telegram → Connection',
                            variant: 'default',
                          });
                        }
                      } catch (e) {
                        toast({
                          title: 'Send failed',
                          description: e instanceof Error ? e.message : String(e),
                          variant: 'error',
                        });
                      }
                    }}
                    title="Send this note to Telegram"
                    stopPropagation={false}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M21.5 4.5 2.5 11.5l6 2m13-9-10 14-3-5m13-9-10 7" />
                    </svg>
                  </IconButton>
                  <IconButton
                    onClick={() => setAiBarOpen((v) => !v)}
                    title={aiBarOpen ? 'Hide AI bar' : 'Rewrite this note with AI'}
                    active={aiBarOpen}
                    stopPropagation={false}
                  >
                    <MagicWandIcon size={13} />
                  </IconButton>
                  {activeId !== null && (
                    <>
                      <Separator orientation="vertical" tone="strong" className="mx-[3px]" />
                      <IconButton
                        onClick={() => void revealNoteFile()}
                        title="Reveal note file in Finder"
                        stopPropagation={false}
                      >
                        <ExternalIcon size={13} />
                      </IconButton>
                      <IconButton
                        onClick={() => void copyNotePath()}
                        title="Copy note file path (e.g. for Claude Code)"
                        stopPropagation={false}
                      >
                        <CopyIcon size={13} />
                      </IconButton>
                    </>
                  )}
                  <Separator orientation="vertical" tone="strong" className="mx-[3px]" />
                  <IconButton
                    onClick={onExport}
                    title={exportDisabled ? 'Nothing to export' : 'Export as .md'}
                    stopPropagation={false}
                  >
                    <DownloadIcon size={13} />
                  </IconButton>
                  {activeId !== null && (
                    <IconButton
                      onClick={removeActive}
                      title="Delete note"
                      tone="danger"
                      stopPropagation={false}
                    >
                      <TrashIcon size={13} />
                    </IconButton>
                  )}
                </div>
              </div>
              {/* Refresh-2026-04 meta row: 11 / 1.5, dot-separated facts.
                * Order matches the bundle: timestamp · word count · folder. */}
              <div
                className="flex items-center flex-wrap gap-2 t-tertiary text-meta"
                style={{ lineHeight: 1.5 }}
              >
                {active && <span className="tabular-nums">Updated {iso(active.updated_at)} ago</span>}
                {body.trim() && (
                  <>
                    {active && <span className="t-ghost" aria-hidden>·</span>}
                    <span className="tabular-nums">{countWords(body)} words</span>
                  </>
                )}
                {(() => {
                  if (!active) return null;
                  const folderName =
                    active.folder_id == null
                      ? 'No folder'
                      : folders.find((f) => f.id === active.folder_id)?.name;
                  if (!folderName) return null;
                  return (
                    <>
                      <span className="t-ghost" aria-hidden>·</span>
                      <span>{folderName}</span>
                    </>
                  );
                })()}
              </div>
            </div>
            {active && (
              <NoteAudioStrip
                note={active}
                onNoteUpdated={() => {
                  void notesGet(active.id).then((fresh) => {
                    if (fresh) setActiveNote(fresh);
                  });
                }}
              />
            )}
            {activeId != null && (
              <NoteAttachmentsPanel
                noteId={activeId}
                onEmbedMarkdown={(snippet) => {
                  // Append as its own paragraph so the embed sits on a
                  // clean line — the preview treats image/audio embeds
                  // on a dedicated line specially (see MarkdownPreview).
                  setBody((prev) => {
                    const sep = prev.endsWith('\n\n') || prev.length === 0
                      ? ''
                      : prev.endsWith('\n')
                      ? '\n'
                      : '\n\n';
                    return `${prev}${sep}${snippet}\n`;
                  });
                }}
              />
            )}
            <div
              className="flex-1 flex min-h-0 relative"
              style={{ ['--notes-zoom' as string]: String(notesZoom) }}
            >
              {showEditor && (
                <div
                  className={`flex flex-col min-h-0 ${showPreview ? 'w-1/2 border-r hair' : 'flex-1'}`}
                >
                  <NoteEditor
                    value={body}
                    onChange={onBodyChange}
                    placeholder="Write markdown — headings, lists, - [ ] checklists…"
                    textareaRef={editorRef}
                    onUndo={handleUndo}
                    onRedo={handleRedo}
                    onImagePasted={(ok, message) =>
                      ok
                        ? toast({ title: 'Image pasted', variant: 'success', durationMs: 1600 })
                        : toast({ title: 'Paste failed', description: message, variant: 'error' })
                    }
                    onTranslateResult={(r) =>
                      r.ok
                        ? toast({ title: 'Translated', variant: 'success', durationMs: 1600 })
                        : toast({
                            title: 'Translate failed',
                            description: r.message,
                            variant: 'error',
                          })
                    }
                  />
                </div>
              )}
              {showPreview && (
                <div
                  className={`${showEditor ? 'w-1/2' : 'flex-1'} overflow-y-auto nice-scroll`}
                  style={{ padding: '14px 18px 60px' }}
                >
                  <MarkdownPreview source={body} onToggleCheckbox={onToggleCheckbox} />
                </div>
              )}
            </div>
            {aiBarOpen && (
              <NoteAiBar
                noteTitle={title}
                body={body}
                onBodyChange={onBodyChange}
                onClose={() => setAiBarOpen(false)}
                onUndo={handleUndo}
                onRedo={handleRedo}
                canUndo={canUndo}
                canRedo={canRedo}
                beginTransaction={beginBodyTransaction}
                endTransaction={endBodyTransaction}
              />
            )}
          </>
        ) : (
          <EmptyState
            glyph
            icon={<PencilIcon size={24} />}
            title="No note selected"
            description="Pick something from the sidebar, or start fresh. Stash autosaves as you type."
            kbdHint={{ label: 'New note', kbd: '⌘⇧N' }}
            action={
              <div className="flex items-center gap-2">
                <Button
                  size="md"
                  variant="solid"
                  tone="accent"
                  onClick={newNote}
                  leadingIcon={<PencilIcon size={12} />}
                >
                  New note
                </Button>
                <Button
                  size="md"
                  variant="ghost"
                  onClick={onImport}
                  leadingIcon={<UploadIcon size={12} />}
                >
                  Import .md
                </Button>
              </div>
            }
          />
        )}
      </main>
      <AudioRecorder
        open={recorderOpen}
        onCancel={() => setRecorderOpen(false)}
        onComplete={onRecorderComplete}
      />
      <ConfirmDialog
        open={deleteConfirm.open}
        title="Delete this note?"
        description="The note and its contents will be removed. This cannot be undone."
        confirmLabel="Delete"
        tone="danger"
        suppressibleLabel="Don't ask again"
        onConfirm={(suppress) => deleteConfirm.confirm(!!suppress)}
        onCancel={deleteConfirm.cancel}
      />
      {(() => {
        const target = noteCtxMenu
          ? notes.find((n) => n.id === noteCtxMenu.noteId)
          : null;
        if (!noteCtxMenu || !target) return null;
        const label = target.title.trim() || 'Untitled';
        const moveItems: ContextMenuItem[] = [];
        if (target.folder_id != null) {
          moveItems.push({
            kind: 'action',
            label: 'Move to: Unfiled',
            onSelect: () =>
              void assignNoteToFolder(target.id, null, 'Unfiled'),
          });
        }
        for (const f of folders) {
          if (f.id === target.folder_id) continue;
          moveItems.push({
            kind: 'action',
            label: `Move to: ${f.name || 'Untitled'}`,
            onSelect: () =>
              void assignNoteToFolder(target.id, f.id, f.name || 'Untitled'),
          });
        }
        const items: ContextMenuItem[] = [
          {
            kind: 'action',
            label: target.pinned ? 'Unpin' : 'Pin',
            onSelect: () => void togglePinned(target.id, !target.pinned),
          },
          {
            kind: 'action',
            label: 'Duplicate',
            shortcut: '⌘D',
            onSelect: () => void duplicateNote(target.id),
          },
          ...(moveItems.length > 0
            ? [{ kind: 'separator' as const }, ...moveItems]
            : []),
          { kind: 'separator' },
          {
            kind: 'action',
            label: 'Reveal in Finder',
            onSelect: () => void revealNoteById(target.id),
          },
          {
            kind: 'action',
            label: 'Copy file path',
            onSelect: () => void copyNotePathById(target.id),
          },
          { kind: 'separator' },
          {
            kind: 'action',
            label: 'Delete',
            tone: 'danger',
            onSelect: () => deleteConfirm.request(target.id, performDelete),
          },
        ];
        return (
          <ContextMenu
            open
            x={noteCtxMenu.x}
            y={noteCtxMenu.y}
            items={items}
            onClose={() => setNoteCtxMenu(null)}
            label={`Actions for note ${label}`}
          />
        );
      })()}
    </div>
  );
};
