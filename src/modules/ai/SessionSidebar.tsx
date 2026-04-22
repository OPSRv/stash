import { useState } from 'react';

import { accent } from '../../shared/theme/accent';
import { Button } from '../../shared/ui/Button';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';

import type { Session } from './api';

type Props = {
  sessions: Session[];
  activeId: string | null;
  expanded: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
};

const relativeDay = (ms: number): string => {
  const d = new Date(ms);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

const initials = (title: string): string => {
  const t = title.trim();
  if (!t) return '·';
  const words = t.split(/\s+/).slice(0, 2);
  return words.map((w) => w[0]?.toUpperCase() ?? '').join('') || t[0]!.toUpperCase();
};

export const SessionSidebar = ({
  sessions,
  activeId,
  expanded,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: Props) => {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const startRename = (s: Session) => {
    setRenamingId(s.id);
    setRenameValue(s.title);
  };

  const commitRename = async () => {
    if (!renamingId) return;
    const next = renameValue.trim();
    if (next) await onRename(renamingId, next);
    setRenamingId(null);
  };

  // Collapsed = fully hidden. The rail of identical "NC" initials was
  // visually noisy without giving the user useful orientation, and the
  // chevron in the chat header is now the single entry point for toggling
  // visibility.
  const width = expanded ? 'w-[220px]' : 'w-0';

  return (
    <>
      <aside
        className={`${width} h-full ${
          expanded ? 'border-r hair' : ''
        } flex flex-col overflow-hidden transition-[width] duration-150`}
        style={{ background: 'var(--color-surface)' }}
        aria-hidden={!expanded}
      >
        <ul className="flex-1 overflow-y-auto nice-scroll py-1 w-[220px]">
          {sessions.length === 0 && (
            <li className="px-3 py-4 t-tertiary text-meta">No conversations yet.</li>
          )}
          {sessions.map((s) => {
            const isActive = s.id === activeId;
            const isRenaming = renamingId === s.id;
            return (
              <li key={s.id}>
                <div
                  className={`group flex items-center gap-2 px-2 py-1.5 cursor-pointer rounded-md mx-1 ${
                    isActive ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]'
                  }`}
                  onClick={() => !isRenaming && onSelect(s.id)}
                >
                  <div
                    className="w-7 h-7 rounded-full flex items-center justify-center text-meta shrink-0"
                    style={{ background: accent(0.18) }}
                  >
                    {initials(s.title)}
                  </div>
                  <div className="flex-1 min-w-0">
                    {isRenaming ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.currentTarget.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename();
                          else if (e.key === 'Escape') setRenamingId(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="input-field w-full px-2 py-0.5 rounded-md text-body"
                        aria-label="Rename chat"
                      />
                    ) : (
                      <>
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="truncate t-primary text-body flex-1 min-w-0">
                            {s.title}
                          </span>
                          {s.kind && (
                            <span
                              className="shrink-0 px-1.5 py-0 rounded text-meta tabular-nums"
                              style={{
                                background: accent(0.16),
                                color: accent(1),
                                fontSize: 9,
                                letterSpacing: 0.3,
                                textTransform: 'uppercase',
                              }}
                              title={`From the ${s.kind} tab`}
                            >
                              {s.kind}
                            </span>
                          )}
                        </div>
                        <div className="truncate t-tertiary text-meta">
                          {relativeDay(s.updated_at)}
                        </div>
                      </>
                    )}
                  </div>
                  {!isRenaming && (
                    <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity">
                      <button
                        type="button"
                        aria-label="Rename"
                        title="Rename"
                        onClick={(e) => {
                          e.stopPropagation();
                          startRename(s);
                        }}
                        className="t-tertiary hover:t-primary px-1.5 py-0.5 rounded-md text-meta"
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        aria-label="Delete"
                        title="Delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeletingId(s.id);
                        }}
                        className="t-tertiary hover:text-red-400 px-1.5 py-0.5 rounded-md text-meta"
                      >
                        ×
                      </button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="border-t hair px-3 py-2 w-[220px] flex items-center min-h-[52px]">
          <Button
            variant="soft"
            tone="accent"
            size="md"
            onClick={onCreate}
            aria-label="New chat"
            title="New chat (⌘N)"
            fullWidth
          >
            + New chat
          </Button>
        </div>
      </aside>
      <ConfirmDialog
        open={deletingId !== null}
        title="Delete chat?"
        description="This removes the conversation and its messages. Cannot be undone."
        confirmLabel="Delete"
        tone="danger"
        onCancel={() => setDeletingId(null)}
        onConfirm={async () => {
          if (deletingId) await onDelete(deletingId);
          setDeletingId(null);
        }}
      />
    </>
  );
};
