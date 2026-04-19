import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SearchInput } from '../../shared/ui/SearchInput';
import { SectionLabel } from '../../shared/ui/SectionLabel';
import {
  notesCreate,
  notesDelete,
  notesList,
  notesSearch,
  notesUpdate,
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

export const NotesShell = () => {
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const saveTimer = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(async () => {
    const data = query.trim() ? await notesSearch(query) : await notesList();
    setNotes(data);
    return data;
  }, [query]);

  useEffect(() => {
    reload().then((data) => {
      // If no active note, select the most recent one.
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

  // Load the selected note into the editor whenever the selection changes.
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
      saveTimer.current = window.setTimeout(async () => {
        try {
          if (activeId == null) {
            if (!nextTitle && !nextBody) return;
            const id = await notesCreate(nextTitle, nextBody);
            setActiveId(id);
          } else {
            await notesUpdate(activeId, nextTitle, nextBody);
          }
          reload();
        } catch (e) {
          console.error('notes save failed', e);
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

  const newNote = async () => {
    const id = await notesCreate('', '');
    setActiveId(id);
    await reload();
  };

  const removeActive = async () => {
    if (activeId == null) return;
    await notesDelete(activeId);
    setActiveId(null);
    setTitle('');
    setBody('');
    await reload();
  };

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
        <div className="px-2 py-1 flex items-center justify-between">
          <SectionLabel>{notes.length} notes</SectionLabel>
          <button
            onClick={newNote}
            className="t-primary text-meta px-2 py-0.5 rounded"
            style={{ background: 'rgba(var(--stash-accent-rgb), 0.22)' }}
            title="New note (⌘N)"
          >
            + New
          </button>
        </div>
        <div className="flex-1 overflow-y-auto nice-scroll">
          {notes.map((n) => (
            <button
              key={n.id}
              onClick={() => setActiveId(n.id)}
              className={`w-full text-left px-3 py-2 flex flex-col gap-0.5 ${
                n.id === activeId ? 'row-active' : ''
              }`}
            >
              <span className="t-primary text-body font-medium truncate">
                {n.title || <span className="t-tertiary">Untitled</span>}
              </span>
              <span className="t-tertiary text-meta truncate">
                {n.body.split('\n')[0] || 'No content'}
              </span>
              <span className="t-tertiary text-[10px] font-mono">
                {iso(n.updated_at)}
              </span>
            </button>
          ))}
          {notes.length === 0 && (
            <div className="p-4 t-tertiary text-meta text-center">
              {query ? 'No matches.' : 'No notes yet. Click + New.'}
            </div>
          )}
        </div>
      </aside>

      <main className="flex-1 flex flex-col">
        {active || (activeId === null && (title || body)) ? (
          <>
            <div className="px-4 pt-3 pb-2 flex items-center gap-2 border-b hair">
              <input
                value={title}
                onChange={(e) => onTitleChange(e.currentTarget.value)}
                placeholder="Title"
                className="flex-1 bg-transparent outline-none t-primary text-heading font-medium"
              />
              {activeId !== null && (
                <button
                  onClick={removeActive}
                  className="t-tertiary hover:text-red-400 text-meta px-2 py-1 rounded"
                  style={{ background: 'rgba(255,255,255,0.04)' }}
                  title="Delete note"
                >
                  Delete
                </button>
              )}
            </div>
            <textarea
              value={body}
              onChange={(e) => onBodyChange(e.currentTarget.value)}
              placeholder="Write markdown or plain text…"
              className="flex-1 bg-transparent outline-none resize-none px-4 py-3 t-primary text-body font-mono leading-relaxed"
              spellCheck={false}
            />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center t-tertiary text-meta">
            Select a note or click + New.
          </div>
        )}
      </main>
    </div>
  );
};
