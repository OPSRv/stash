import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { SearchInput } from '../../shared/ui/SearchInput';
import { Button } from '../../shared/ui/Button';
import { IconButton } from '../../shared/ui/IconButton';
import { SegmentedControl } from '../../shared/ui/SegmentedControl';
import { AskAiButton } from '../../shared/ui/AskAiButton';
import {
  DownloadIcon,
  EyeIcon,
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
import { NoteEditor, type NotesViewMode } from './NoteEditor';
import { MarkdownPreview } from './MarkdownPreview';
import { SaveStatusPill, type SaveStatus } from './SaveStatusPill';
import { AudioRecorder, type RecordedAudio } from './AudioRecorder';
import { AudioNoteView } from './AudioNoteView';
import { toggleCheckboxAtLine } from './markdown';
import { polishTranscript } from './polish';
import { loadSettings } from '../../settings/store';
import { whisperGetActive, whisperTranscribe } from '../whisper/api';
import {
  notesCreate,
  notesCreateAudio,
  notesDelete,
  notesGet,
  notesList,
  notesReadFile,
  notesSearch,
  notesSetPinned,
  notesUpdate,
  notesWriteFile,
  type Note,
  type NoteSummary,
} from './api';

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

const formatDuration = (ms: number | null): string => {
  if (!ms || ms <= 0) return '—';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const AUTOSAVE_DEBOUNCE_MS = 400;
const SIDEBAR_COLLAPSED_KEY = 'stash:notes:sidebar-collapsed';

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

export const NotesShell = () => {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  // Full note for the currently active row — loaded on demand from Rust so
  // the list itself can stay on summaries. AudioNoteView reads from here too.
  const [activeNote, setActiveNote] = useState<Note | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
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
  const [sidebarCollapsed, setSidebarCollapsedState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage?.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
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
    const data = query.trim() ? await notesSearch(query) : await notesList();
    setNotes(data);
    return data;
  }, [query]);

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
  }, [query]);

  const active = activeNote;

  // Load the full body on activation — the side-list only carries summaries,
  // so opening Notes ships at most ~150 KB across IPC even with 500 entries.
  useEffect(() => {
    if (activeId == null) {
      setActiveNote(null);
      setTitle('');
      setBody('');
      return;
    }
    let cancelled = false;
    void notesGet(activeId).then((note) => {
      if (cancelled || !note) return;
      setActiveNote(note);
      setTitle(note.title);
      setBody(note.body);
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
    // Brand-new blank note — drop the user straight into the editor instead of
    // the empty preview pane. Existing notes open in preview (see row onClick).
    setViewMode('edit');
    await reload();
  };

  const onRecorderComplete = useCallback(
    async (audio: RecordedAudio) => {
      setRecorderOpen(false);
      let createdId: number | null = null;
      try {
        const created = await notesCreateAudio({
          title: `Voice note · ${new Date().toLocaleString()}`,
          bytes: audio.bytes,
          ext: audio.ext,
          durationMs: audio.durationMs,
        });
        createdId = created.id;
        setActiveId(created.id);
        await reload();
        toast({
          title: 'Voice note saved',
          description: formatDuration(audio.durationMs),
          variant: 'success',
        });
      } catch (e) {
        console.error('voice note save failed', e);
        toast({ title: 'Couldn\u2019t save recording', description: String(e), variant: 'error' });
        return;
      }

      // Auto-transcribe / auto-polish, both gated on user settings. Both
      // steps are best-effort — failures show a toast but don't roll back
      // the recording itself.
      const settings = await loadSettings().catch(() => null);
      if (!settings?.notesAutoTranscribe) return;
      const activeModel = await whisperGetActive().catch(() => null);
      if (!activeModel || createdId == null) return;
      let transcript: string | null = null;
      setSaveStatus('transcribing');
      toast({ title: 'Transcribing voice note…', variant: 'default', durationMs: 2200 });
      try {
        transcript = await whisperTranscribe(createdId, 'uk');
        setBody(transcript);
        await reload();
        setSaveStatus('saved');
        if (savedClearTimer.current !== null) window.clearTimeout(savedClearTimer.current);
        savedClearTimer.current = window.setTimeout(() => setSaveStatus('idle'), 1800);
        toast({ title: 'Transcribed', variant: 'success', durationMs: 2000 });
      } catch (e) {
        setSaveStatus('error');
        toast({
          title: 'Auto-transcribe failed',
          description: String(e),
          variant: 'error',
        });
        return;
      }
      if (!settings.notesAutoPolish || !transcript?.trim()) return;
      setSaveStatus('polishing');
      toast({ title: 'Polishing transcript…', variant: 'default', durationMs: 2200 });
      try {
        const polish = await polishTranscript(transcript, {
          aiProvider: settings.aiProvider,
          aiModel: settings.aiModel,
          aiBaseUrl: settings.aiBaseUrl,
          aiSystemPrompt: settings.aiSystemPrompt,
          aiApiKeys: settings.aiApiKeys,
          aiWebServices: settings.aiWebServices,
        });
        if (polish.kind !== 'ok') {
          setSaveStatus('idle');
          return;
        }
        await notesUpdate(createdId, `Voice note · ${new Date().toLocaleString()}`, polish.text);
        setBody(polish.text);
        await reload();
        setSaveStatus('saved');
        if (savedClearTimer.current !== null) window.clearTimeout(savedClearTimer.current);
        savedClearTimer.current = window.setTimeout(() => setSaveStatus('idle'), 1800);
        toast({ title: 'Polished', variant: 'success', durationMs: 2000 });
      } catch (e) {
        setSaveStatus('error');
        toast({
          title: 'Auto-polish failed',
          description: String(e),
          variant: 'error',
        });
      }
    },
    [reload, toast],
  );

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

  const isAudio = Boolean(active?.audio_path);
  const isEditing = active || (activeId === null && (title || body));
  const exportDisabled = !body && !title;
  const showEditor = !isAudio && viewMode !== 'preview';
  const showPreview = !isAudio && viewMode !== 'edit';

  const renderNoteRow = (n: NoteSummary) => {
    const rowAudio = Boolean(n.audio_path);
    const preview = rowAudio
      ? `Voice memo · ${formatDuration(n.audio_duration_ms)}`
      : n.preview.split('\n').find((l) => l.trim()) || 'No content';
    const open = () => {
      setActiveId(n.id);
      setViewMode('preview');
    };
    return (
      <div
        key={n.id}
        role="button"
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        }}
        className={`group w-full text-left px-3 py-2 cursor-pointer transition-colors ring-focus ${
          n.id === activeId ? 'row-active' : 'hover:bg-white/[0.03]'
        }`}
      >
        <div className="flex items-baseline gap-2">
          {rowAudio && (
            <span
              className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full"
              style={{
                background: 'rgba(var(--stash-accent-rgb), 0.18)',
                color: 'rgba(var(--stash-accent-rgb), 1)',
              }}
              aria-hidden
            >
              <MicIcon size={9} />
            </span>
          )}
          <span className="t-primary text-body font-medium truncate flex-1 min-w-0">
            {n.title || <span className="t-tertiary">Untitled</span>}
          </span>
          {/* Trailing slot: timestamp by default, pin toggle on row hover/focus
              and always when the note is pinned. Same width avoids layout
              jumps when the trailing element swaps. */}
          <span className="shrink-0 relative inline-flex items-center justify-end w-7 h-4">
            <span
              className={`t-tertiary text-[10px] font-mono ${
                n.pinned ? 'hidden' : 'group-hover:hidden group-focus-within:hidden'
              }`}
            >
              {iso(n.updated_at)}
            </span>
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                void togglePinned(n.id, !n.pinned);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  void togglePinned(n.id, !n.pinned);
                }
              }}
              title={n.pinned ? 'Unpin note' : 'Pin note'}
              aria-label={n.pinned ? 'Unpin note' : 'Pin note'}
              aria-pressed={n.pinned}
              className={`ring-focus rounded p-0.5 t-tertiary hover:t-primary cursor-pointer ${
                n.pinned
                  ? 'inline-flex items-center'
                  : 'hidden group-hover:inline-flex group-focus-within:inline-flex items-center'
              }`}
              style={n.pinned ? { color: 'var(--stash-accent)' } : undefined}
            >
              <PinIcon size={11} filled={n.pinned} />
            </span>
          </span>
        </div>
        <div className="t-tertiary text-meta truncate mt-0.5">{preview}</div>
      </div>
    );
  };

  return (
    <div className="h-full flex">
      <aside
        className="relative shrink-0 border-r hair overflow-hidden transition-[width] duration-200 ease-out"
        style={{ width: sidebarCollapsed ? 40 : 220 }}
      >
        <div
          className={`absolute inset-y-0 left-0 w-10 flex flex-col items-center py-2 gap-1 transition-opacity duration-150 ${
            sidebarCollapsed ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          aria-hidden={!sidebarCollapsed}
        >
          <IconButton
            onClick={() => setSidebarCollapsed(false)}
            title="Expand notes list"
            stopPropagation={false}
          >
            <PanelLeftIcon size={14} />
          </IconButton>
          <IconButton
            onClick={newNote}
            title="New note (⌘N)"
            stopPropagation={false}
          >
            <PencilIcon size={13} />
          </IconButton>
          <IconButton
            onClick={() => setRecorderOpen(true)}
            title="Record voice note"
            stopPropagation={false}
          >
            <MicIcon size={13} />
          </IconButton>
          <IconButton
            onClick={expandSidebarAndFocusSearch}
            title="Search notes"
            stopPropagation={false}
          >
            <SearchIcon size={13} />
          </IconButton>
          <div className="flex-1" />
          <IconButton
            onClick={onImport}
            title="Import .md"
            stopPropagation={false}
          >
            <UploadIcon size={13} />
          </IconButton>
        </div>
        <div
          className={`absolute inset-y-0 left-0 w-[220px] flex flex-col transition-opacity duration-150 ${
            sidebarCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'
          }`}
          aria-hidden={sidebarCollapsed}
        >
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search notes"
          inputRef={searchRef}
          compact
          trailing={
            <IconButton
              onClick={() => setSidebarCollapsed(true)}
              title="Collapse notes list"
              stopPropagation={false}
            >
              <PanelLeftIcon size={13} />
            </IconButton>
          }
        />
        <div className="px-2.5 pt-1 pb-1.5 flex items-stretch gap-1.5">
          <Button
            size="sm"
            variant="soft"
            tone="accent"
            onClick={newNote}
            title="New note (⌘N)"
            className="flex-1 justify-center"
            leadingIcon={<PencilIcon size={12} />}
          >
            New note
          </Button>
          <Button
            size="sm"
            variant="soft"
            tone="accent"
            shape="square"
            onClick={() => setRecorderOpen(true)}
            title="Record voice note"
            aria-label="Record voice note"
          >
            <MicIcon size={13} />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto nice-scroll">
          {pinnedNotes.length > 0 && (
            <div className="px-3 pt-3 pb-1">
              <SectionLabel>Pinned</SectionLabel>
            </div>
          )}
          {pinnedNotes.map((n) => renderNoteRow(n))}
          {pinnedNotes.length > 0 && recentNotes.length > 0 && (
            <div className="px-3 pt-3 pb-1">
              <SectionLabel>Recent</SectionLabel>
            </div>
          )}
          {recentNotes.map((n) => renderNoteRow(n))}
          {notes.length === 0 && (
            <EmptyState
              variant="compact"
              title={query ? 'No matches' : 'No notes yet'}
              description={query ? 'Try a different search.' : 'Create your first note below.'}
            />
          )}
        </div>
        <div className="px-3 py-2 border-t hair">
          <Button
            size="sm"
            variant="ghost"
            onClick={onImport}
            title="Open a markdown or text file as a new note"
            fullWidth
            leadingIcon={<UploadIcon size={12} />}
          >
            Import .md
          </Button>
        </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        {isEditing ? (
          <>
            <div className="px-4 pt-3 pb-2 border-b hair">
              <div className="flex items-center gap-3">
                <input
                  value={title}
                  onChange={(e) => onTitleChange(e.currentTarget.value)}
                  placeholder="Untitled"
                  className="flex-1 bg-transparent outline-none t-primary text-heading font-medium min-w-0"
                />
                <SaveStatusPill status={saveStatus} />
                {!isAudio && (
                  <SegmentedControl
                    size="sm"
                    options={VIEW_MODE_OPTIONS}
                    value={viewMode}
                    onChange={setViewMode}
                    ariaLabel="View mode"
                  />
                )}
                <div className="w-px h-5 bg-white/[0.08]" aria-hidden />
                <div className="flex items-center gap-1 shrink-0">
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
                  <AskAiButton
                    text={() => (body.trim() ? body : title)}
                    disabled={!body.trim() && !title.trim()}
                    size={13}
                    title="Ask AI about this note (opens a new chat)"
                  />
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
              <div className="mt-1 flex items-center gap-3 t-tertiary text-meta tabular-nums">
                {active && <span>Updated {iso(active.updated_at)} ago</span>}
                {!isAudio && body.trim() && (
                  <>
                    {active && <span aria-hidden>·</span>}
                    <span>{countWords(body)} words</span>
                  </>
                )}
              </div>
            </div>
            <div className="flex-1 flex min-h-0">
              {isAudio && active && (
                <AudioNoteView
                  note={active}
                  onTranscriptUpdated={(_id, merged) => {
                    // Reflect the server-side body bump locally so the
                    // editor/preview updates without waiting for a reload,
                    // then reload in the background to sync timestamps.
                    setBody(merged);
                    reload();
                  }}
                />
              )}
              {showEditor && (
                <div
                  className={`flex flex-col min-h-0 ${showPreview ? 'w-1/2 border-r hair' : 'flex-1'}`}
                >
                  <NoteEditor
                    value={body}
                    onChange={onBodyChange}
                    placeholder="Write markdown — headings, lists, - [ ] checklists…"
                    textareaRef={editorRef}
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
    </div>
  );
};
