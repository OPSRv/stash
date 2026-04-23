import { useEffect, useRef, useState } from 'react';

import { MAX_TABS, type DropPosition, type Tab } from '../types';
import { defaultTabLabel, tabLabel } from '../state/tabStorage';

export type TabBarProps = {
  tabs: Tab[];
  activeId: string;
  /// Id of the tab currently under the drag pointer, or `''` when no
  /// drag is in progress. Driven by the shell's drag manager.
  dropOverTab: string;
  /// Resolved drop zone for tab-on-tab drags (`'left' | 'right'`), used
  /// to render the accent drop-line on the correct edge. `'center'` or
  /// null suppresses the line (pane→tab drops paint the whole tab).
  dropZone?: DropPosition | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onAdd: () => void;
  onRename: (tabId: string, nextLabel: string | undefined) => void;
  /// Pointer-down factory from the shell's drag manager.
  onTabDragStart: (
    tabId: string,
    label: string,
  ) => (e: React.PointerEvent) => void;
};

/// Tab strip above the terminal. Tabs live in a horizontally scrollable
/// flex row — native scrollbar hidden, edge fades hint at overflow. The
/// "+" button stays fixed outside the scroll area so it's always
/// reachable. Drop target via `data-drop-target` so `useDrag` routes both
/// tab-reorder (tab → tab) and pane-move (pane → tab) through a single
/// gesture path.
export const TabBar = ({
  tabs,
  activeId,
  dropOverTab,
  dropZone = null,
  onActivate,
  onClose,
  onAdd,
  onRename,
  onTabDragStart,
}: TabBarProps) => {
  // Inline rename state is tab-bar-local — the shell doesn't care which
  // tab is mid-rename, only the committed label.
  const [editingId, setEditingId] = useState<string>('');
  const [draft, setDraft] = useState<string>('');

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [fadeLeft, setFadeLeft] = useState(false);
  const [fadeRight, setFadeRight] = useState(false);

  const beginEdit = (tab: Tab, defaultLabel: string) => {
    setEditingId(tab.id);
    setDraft(tab.label ?? defaultLabel);
  };
  const commit = () => {
    if (!editingId) return;
    const raw = draft.trim();
    onRename(editingId, raw.length > 0 ? raw.slice(0, 32) : undefined);
    setEditingId('');
    setDraft('');
  };
  const cancel = () => {
    setEditingId('');
    setDraft('');
  };

  // Watch the scroll container so the edge fades only show when content
  // actually overflows. Listens to both scroll events and resize (tab
  // add/close) via ResizeObserver.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      setFadeLeft(el.scrollLeft > 2);
      setFadeRight(max > 2 && el.scrollLeft < max - 2);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [tabs.length]);

  // Keep the active tab visible after activation via keyboard shortcut.
  useEffect(() => {
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `[data-testid="terminal-tab-${activeId}"]`,
    );
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  return (
    <div
      className="relative flex items-stretch shrink-0 border-b hair"
      data-testid="terminal-tab-bar"
      style={{
        background: 'var(--color-surface-raised, rgba(255,255,255,0.03))',
        minHeight: 28,
      }}
    >
      <div
        ref={scrollRef}
        className="terminal-tabbar-scroll flex items-stretch flex-1 overflow-x-auto overflow-y-hidden"
        style={{ minWidth: 0 }}
      >
        {tabs.map((t, idx) => {
          const active = t.id === activeId;
          const label = tabLabel(t, idx);
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={active}
              data-drop-target={`tab:${t.id}`}
              onClick={() => onActivate(t.id)}
              onPointerDown={onTabDragStart(t.id, label)}
              className="group flex items-center gap-1.5 px-3 py-1 text-meta cursor-pointer select-none shrink-0"
              style={{
                position: 'relative',
                maxWidth: 180,
                color: active
                  ? 'var(--color-text-primary, #e7e7ea)'
                  : 'var(--color-text-tertiary, rgba(255,255,255,0.55))',
                background:
                  // Pane→tab drops flood the whole tab (move-into-tab);
                  // tab→tab drops use a thin edge line instead (handled
                  // via the overlay div below).
                  dropOverTab === t.id && dropZone === 'center'
                    ? 'var(--stash-accent)'
                    : active
                      ? 'rgba(255,255,255,0.05)'
                      : 'transparent',
                borderRight:
                  '1px solid var(--color-border-hair, rgba(255,255,255,0.06))',
                boxShadow: active
                  ? 'inset 0 -1.5px 0 0 var(--stash-accent)'
                  : 'none',
                transition: 'background 120ms, color 120ms',
              }}
              data-testid={`terminal-tab-${t.id}`}
            >
              {editingId === t.id ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commit}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commit();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancel();
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onFocus={(e) => e.currentTarget.select()}
                  className="bg-transparent outline-none t-primary text-meta"
                  style={{
                    border: '1px solid var(--stash-accent)',
                    borderRadius: 3,
                    padding: '0 4px',
                    width: Math.max(60, draft.length * 8 + 20),
                  }}
                  maxLength={32}
                  data-testid={`terminal-tab-rename-${t.id}`}
                />
              ) : (
                <span
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    beginEdit(t, defaultTabLabel(t, idx));
                  }}
                  title={`${label} — double-click to rename`}
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                  }}
                >
                  {label}
                </span>
              )}
              {dropOverTab === t.id &&
                (dropZone === 'left' || dropZone === 'right') && (
                  <span
                    aria-hidden
                    style={{
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      [dropZone === 'left' ? 'left' : 'right']: -1,
                      width: 2,
                      background: 'var(--stash-accent)',
                      boxShadow: '0 0 6px 0 rgba(var(--stash-accent-rgb), 0.6)',
                      pointerEvents: 'none',
                    }}
                  />
                )}
              {tabs.length > 1 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(t.id);
                  }}
                  aria-label={`Close ${label}`}
                  className="w-4 h-4 flex items-center justify-center rounded-sm t-tertiary opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:t-primary hover:bg-white/[0.08] shrink-0"
                  title="Close tab"
                  style={{
                    fontSize: 12,
                    lineHeight: 1,
                    opacity: active ? 1 : undefined,
                  }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
        <button
          type="button"
          onClick={onAdd}
          disabled={tabs.length >= MAX_TABS}
          aria-label="New shell"
          title={
            tabs.length >= MAX_TABS
              ? `Max ${MAX_TABS} tabs`
              : 'New shell (open another terminal session)'
          }
          className="shrink-0 flex items-center justify-center t-tertiary hover:t-primary hover:bg-white/[0.08] disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-colors"
          style={{
            width: 28,
            height: 'auto',
            fontSize: 16,
            lineHeight: 1,
            alignSelf: 'stretch',
          }}
          data-testid="terminal-tab-new"
        >
          +
        </button>
      </div>
      <div
        className="terminal-tabbar-fade terminal-tabbar-fade-left"
        data-visible={fadeLeft}
      />
      <div
        className="terminal-tabbar-fade terminal-tabbar-fade-right"
        data-visible={fadeRight}
      />
    </div>
  );
};
