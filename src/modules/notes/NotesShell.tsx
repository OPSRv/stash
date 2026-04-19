import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { SearchInput } from '../../shared/ui/SearchInput';
import { Button } from '../../shared/ui/Button';
import { IconButton } from '../../shared/ui/IconButton';
import { SegmentedControl } from '../../shared/ui/SegmentedControl';
import { DownloadIcon, TrashIcon, UploadIcon } from '../../shared/ui/icons';
import { useToast } from '../../shared/ui/Toast';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { EmptyState } from '../../shared/ui/EmptyState';
import { useSuppressibleConfirm } from '../../shared/hooks/useSuppressibleConfirm';
import { NoteEditor, type NotesViewMode } from './NoteEditor';
import { MarkdownPreview } from './MarkdownPreview';
import { SaveStatusPill } from './SaveStatusPill';
import { toggleCheckboxAtLine } from './markdown';
import {
  notesCreate,
  notesDelete,
  notesList,
  notesReadFile,
  notesSearch,
  notesUpdate,
  notesWriteFile,
  type Note,
} from './api';

const iso = (ts: number) => {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
};

const AUTOSAVE_DEBOUNCE_MS = 400;

const VIEW_MODE_OPTIONS = [
  { value: 'edit' as const, label: 'Edit', title: 'Editor only' },
  { value: 'split' as const, label: 'Split', title: 'Editor + preview' },
  { value: 'preview' as const, label: 'Preview', title: 'Preview only' },
];

export const NotesShell = () => {
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [viewMode, setViewMode] = useState<NotesViewMode>('split');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saveTimer = useRef<number | null>(null);
  const savedClearTimer = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  /// Guards against duplicate `notesCreate` when the initial save round-trip
  /// is slower than the debounce window — a pending create sets this to the
  /// in-flight promise so later saves wait for `activeId` to land.
  const pendingCreateRef = useRef<Promise<number> | null>(null);
  const { toast } = useToast();

  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      if (savedClearTimer.current !== null) window.clearTimeout(savedClearTimer.current);
    },
    [],
  );

  const reload = useCallback(async () => {
    const data = query.trim() ? await notesSearch(query) : await notesList();
    setNotes(data);
    return data;
  }, [query]);

  useEffect(() => {
    reload().then((data) => {
      if (activeId == null && data.length > 0) {
        setActiveId(data[0].id);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const active = useMemo(
    () => notes.find((n) => n.id === activeId) ?? null,
    [notes, activeId]
  );

  useEffect(() => {
    if (active) {
      setTitle(active.title);
      setBody(active.body);
    } else {
      setTitle('');
      setBody('');
    }
  }, [activeId]);
  // intentionally not depending on `active` to avoid overwriting the editor
  // after a debounced autosave refresh reuses the same id.

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
    setActiveId(id);
    await reload();
  };

  const deleteConfirm = useSuppressibleConfirm<number>('notes.delete');

  const performDelete = useCallback(
    async (id: number) => {
      await notesDelete(id);
      setActiveId(null);
      setTitle('');
      setBody('');
      await reload();
    },
    [reload]
  );

  const removeActive = () => {
    if (activeId == null) return;
    deleteConfirm.request(activeId, performDelete);
  };

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

  return (
    <div className="h-full flex">
      <aside className="w-[220px] flex flex-col border-r hair">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search notes"
          shortcutHint="⌘K"
          inputRef={searchRef}
        />
        <div className="px-3 pt-1 pb-2">
          <Button
            size="sm"
            variant="soft"
            tone="accent"
            onClick={newNote}
            title="New note (⌘N)"
            className="w-full justify-center"
          >
            + New note
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto nice-scroll">
          {notes.map((n) => (
            <button
              key={n.id}
              onClick={() => setActiveId(n.id)}
              className={`w-full text-left px-3 py-2 cursor-pointer ${
                n.id === activeId ? 'row-active' : ''
              }`}
            >
              <div className="flex items-baseline gap-2">
                <span className="t-primary text-body font-medium truncate flex-1 min-w-0">
                  {n.title || <span className="t-tertiary">Untitled</span>}
                </span>
                <span className="t-tertiary text-[10px] font-mono shrink-0">
                  {iso(n.updated_at)}
                </span>
              </div>
              <div className="t-tertiary text-meta truncate mt-0.5">
                {n.body.split('\n').find((l) => l.trim()) || 'No content'}
              </div>
            </button>
          ))}
          {notes.length === 0 && (
            <EmptyState
              variant="compact"
              title={query ? 'No matches' : 'No notes yet'}
              description={query ? 'Try a different search.' : 'Create your first note below.'}
            />
          )}
        </div>
        <div className="px-3 py-2 border-t hair">
          <button
            type="button"
            onClick={onImport}
            className="w-full inline-flex items-center justify-center gap-1.5 t-tertiary hover:t-secondary text-meta"
            title="Import .md file"
          >
            <UploadIcon size={12} />
            Import .md file
          </button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        {isEditing ? (
          <>
            <div className="px-4 pt-3 pb-2 flex items-center gap-3 border-b hair">
              <input
                value={title}
                onChange={(e) => onTitleChange(e.currentTarget.value)}
                placeholder="Untitled"
                className="flex-1 bg-transparent outline-none t-primary text-heading font-medium min-w-0"
              />
              <SaveStatusPill status={saveStatus} />
              <SegmentedControl
                size="sm"
                options={VIEW_MODE_OPTIONS}
                value={viewMode}
                onChange={setViewMode}
                ariaLabel="View mode"
              />
              <div className="flex items-center gap-1 shrink-0">
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
            <div className="flex-1 flex min-h-0">
              {showEditor && (
                <div
                  className={`flex flex-col min-h-0 ${showPreview ? 'w-1/2 border-r hair' : 'flex-1'}`}
                >
                  <NoteEditor
                    value={body}
                    onChange={onBodyChange}
                    placeholder="Write markdown — headings, lists, - [ ] checklists…"
                    textareaRef={editorRef}
                  />
                </div>
              )}
              {showPreview && (
                <div
                  className={`${showEditor ? 'w-1/2' : 'flex-1'} overflow-y-auto nice-scroll px-5 py-4`}
                >
                  <MarkdownPreview source={body} onToggleCheckbox={onToggleCheckbox} />
                </div>
              )}
            </div>
          </>
        ) : (
          <EmptyState
            title="Your scratchpad"
            description="Markdown notes with live preview. Press ⌘⇧N anywhere to quick-open."
            action={
              <div className="flex items-center gap-2">
                <Button size="sm" variant="soft" tone="accent" onClick={newNote}>
                  + New note
                </Button>
                <Button size="sm" variant="ghost" onClick={onImport}>
                  Import .md
                </Button>
              </div>
            }
          />
        )}
      </main>
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
    </div>
  );
};
