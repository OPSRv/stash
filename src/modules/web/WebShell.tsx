import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { saveSetting, type WebChatService } from '../../settings/store';
import { Input } from '../../shared/ui/Input';
import { Tooltip } from '../../shared/ui/Tooltip';
import { useToast } from '../../shared/ui/Toast';
import { accent } from '../../shared/theme/accent';
import { copyText } from '../../shared/util/clipboard';

import { AddWebServiceModal } from './AddWebServiceModal';
import { EmbeddedWebChat } from './EmbeddedWebChat';
import { Favicon } from './Favicon';
import { useWebServices } from './useWebServices';
import { isEmbeddableUrl, reorderServices } from './webServiceUtils';
import { webchatClose, webchatHideAll, type WebchatNav } from './webchatApi';

/// MIME type we use for drag-reordering tabs so we don't collide with the
/// `text/uri-list` drop target on the same tab bar (which opens the add
/// dialog). The id rides in the payload as plain text.
const TAB_DRAG_MIME = 'application/x-stash-webtab';

/// Payload re-broadcast to `EmbeddedWebChat` when the host receives a
/// shortcut event from an injected script. Decoupling via a CustomEvent
/// keeps `EmbeddedWebChat` independent of Tauri's listen wiring.
export type WebShortcutDetail = {
  service: string;
  key: string;
  shift: boolean;
};

const LAST_TAB_KEY = 'stash.web.lastTab';
const COLLAPSED_KEY = 'stash.web.collapsed';
const LAST_USED_KEY = 'stash.web.lastUsed';

/// Tabs that haven't been opened in this many ms fade out (pinned excluded).
/// 24h matches Arc's default "archive" threshold feel without being so
/// aggressive that a tab used yesterday morning looks abandoned tonight.
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const readLastUsed = (): Record<string, number> => {
  try {
    const raw = localStorage.getItem(LAST_USED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
};

const writeLastUsed = (map: Record<string, number>) => {
  try {
    localStorage.setItem(LAST_USED_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
};

type ContextMenuState = { id: string; x: number; y: number } | null;

/// Arc-style host: collapsible left sidebar with Pinned/Tabs sections, slim
/// toolbar in the main area. Tabs are favicon+label rows; drag to reorder
/// within a section, right-click for actions, double-click to rename.
export const WebShell = () => {
  const services = useWebServices();
  const { toast } = useToast();

  /// Root-element ref used to gate host-level keyboard shortcuts. The
  /// popup shell keeps every previously-visited tab mounted inside a
  /// `<div hidden={!isActive}>` wrapper, so WebShell's window-level
  /// `keydown` listeners keep firing even when the user is on
  /// Clipboard / Notes / any other tab. `closest('[hidden]')` walks
  /// ancestors looking for that wrapper — null means we're the active
  /// tab, non-null means we're hidden and must early-out.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const isActiveTab = () => !rootRef.current?.closest('[hidden]');

  const [storedActive, setStoredActive] = useState<string>(() => {
    try {
      return localStorage.getItem(LAST_TAB_KEY) ?? '';
    } catch {
      return '';
    }
  });

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });

  const [lastUsed, setLastUsed] = useState<Record<string, number>>(() => readLastUsed());

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const setActive = useCallback((next: string) => {
    setStoredActive(next);
    try {
      localStorage.setItem(LAST_TAB_KEY, next);
    } catch {
      // ignore
    }
    if (next) {
      setLastUsed((prev) => {
        const merged = { ...prev, [next]: Date.now() };
        writeLastUsed(merged);
        return merged;
      });
    }
  }, []);

  const activeService = useMemo(
    () => services.find((s) => s.id === storedActive),
    [storedActive, services],
  );

  const closeService = useCallback(
    async (id: string) => {
      if (storedActive === id) setActive('');
      await webchatClose(id).catch(() => {});
    },
    [storedActive, setActive],
  );

  const [addOpen, setAddOpen] = useState(false);
  const [addPrefillUrl, setAddPrefillUrl] = useState('');
  const [dragOver, setDragOver] = useState(false);

  const openAddDialog = useCallback((prefillUrl = '') => {
    setAddPrefillUrl(prefillUrl);
    setAddOpen(true);
    void webchatHideAll().catch(() => {});
  }, []);

  const persistServices = useCallback(
    async (next: WebChatService[], action: string) => {
      try {
        await saveSetting('aiWebServices', next);
        window.dispatchEvent(
          new CustomEvent('stash:settings-changed', { detail: 'aiWebServices' }),
        );
      } catch (e) {
        toast({
          title: `Could not ${action}`,
          description: e instanceof Error ? e.message : String(e),
          variant: 'error',
        });
      }
    },
    [toast],
  );

  const handleAddService = useCallback(
    async (svc: WebChatService) => {
      await persistServices([...services, svc], 'save tab');
      setActive(svc.id);
    },
    [persistServices, services, setActive],
  );

  const handleRenameService = useCallback(
    async (id: string, nextLabel: string) => {
      const trimmed = nextLabel.trim();
      if (!trimmed) return;
      const next = services.map((s) => (s.id === id ? { ...s, label: trimmed } : s));
      await persistServices(next, 'rename tab');
    },
    [persistServices, services],
  );

  const handleZoomChange = useCallback(
    async (id: string, zoom: number) => {
      const next = services.map((s) => (s.id === id ? { ...s, zoom } : s));
      await persistServices(next, 'update zoom');
    },
    [persistServices, services],
  );

  const handlePinCurrentAsHome = useCallback(
    async (id: string, url: string) => {
      const next = services.map((s) => (s.id === id ? { ...s, url } : s));
      await persistServices(next, 'update home URL');
      toast({ title: 'Home URL updated', variant: 'success' });
    },
    [persistServices, services, toast],
  );

  const togglePin = useCallback(
    async (id: string) => {
      const next = services.map((s) => (s.id === id ? { ...s, pinned: !s.pinned } : s));
      await persistServices(next, 'toggle pin');
    },
    [persistServices, services],
  );

  const duplicateService = useCallback(
    async (id: string) => {
      const idx = services.findIndex((s) => s.id === id);
      if (idx < 0) return;
      const src = services[idx];
      // Collision-free id: base + counter. Keeps things deterministic for
      // repeated duplicates of the same source.
      const existing = new Set(services.map((s) => s.id));
      let n = 2;
      let newId = `${src.id}-${n}`;
      while (existing.has(newId)) {
        n += 1;
        newId = `${src.id}-${n}`;
      }
      const clone: WebChatService = { ...src, id: newId, label: `${src.label} copy` };
      const next = [...services.slice(0, idx + 1), clone, ...services.slice(idx + 1)];
      await persistServices(next, 'duplicate tab');
    },
    [persistServices, services],
  );

  const deleteService = useCallback(
    async (id: string) => {
      const next = services.filter((s) => s.id !== id);
      await persistServices(next, 'delete tab');
      if (storedActive === id) setActive('');
      await webchatClose(id).catch(() => {});
    },
    [persistServices, services, setActive, storedActive],
  );

  const closeOthers = useCallback(
    async (keepId: string) => {
      // "Close" here mirrors the × button: unembed (free RAM) but keep
      // the service rows in the sidebar.
      await Promise.all(
        services
          .filter((s) => s.id !== keepId)
          .map((s) => webchatClose(s.id).catch(() => {})),
      );
      if (storedActive !== keepId) setActive(keepId);
    },
    [services, setActive, storedActive],
  );

  const copyServiceUrl = useCallback(
    async (svc: WebChatService) => {
      try {
        if (!(await copyText(svc.url))) throw new Error('clipboard unavailable');
        toast({ title: 'URL copied', description: svc.url, variant: 'success' });
      } catch (e) {
        toast({
          title: 'Could not copy URL',
          description: e instanceof Error ? e.message : String(e),
          variant: 'error',
        });
      }
    },
    [toast],
  );

  // External nudge (e.g. clicking the webchat Now Playing bar in the popup
  // shell) to surface a specific service.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (typeof id === 'string' && id) setActive(id);
    };
    window.addEventListener('stash:web-open-service', onOpen);
    return () => window.removeEventListener('stash:web-open-service', onOpen);
  }, [setActive]);

  // Bridge shortcuts that come from *inside* the child webview (forwarded
  // via stashnp://report/shortcut → tauri event) into the frontend. We
  // handle service-independent keys here (`w` closes the active tab) and
  // rebroadcast the rest as a DOM CustomEvent so EmbeddedWebChat can react
  // without caring that the origin was a Tauri event.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<WebShortcutDetail>('webchat:shortcut', (evt) => {
      const d = evt.payload;
      if (!d || !d.service) return;
      if (d.key === 'w') {
        closeService(d.service).catch(() => {});
        return;
      }
      window.dispatchEvent(
        new CustomEvent<WebShortcutDetail>('stash:web-shortcut', { detail: d }),
      );
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, [closeService]);

  // Host-side shortcuts:
  //   ⌘W       — close the active tab's webview
  //   ⌘S       — toggle the sidebar
  //   ⌘⇧C      — copy the active tab's URL to the system clipboard
  //              (mirrors Safari/Chrome's "Copy Link to Current Page")
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      // Only react when the Web tab is actually on-screen — otherwise
      // the user copying something in Clipboard/Notes with ⌘⇧C would
      // get our "Copy URL" path silently running.
      if (!isActiveTab()) return;
      const k = e.key.toLowerCase();
      if (e.shiftKey && k === 'c' && activeService) {
        e.preventDefault();
        copyServiceUrl(activeService).catch(() => {});
        return;
      }
      if (k === 'w' && storedActive) {
        e.preventDefault();
        closeService(storedActive).catch(() => {});
      } else if (k === 's') {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeService, storedActive, toggleCollapsed, activeService, copyServiceUrl]);

  // Per-service live URL/title, mirrored from `webchat:nav`. Drives the
  // sidebar favicon + tooltip so each tab row reflects the page the
  // user is actually on (after navigation inside the webview) rather
  // than the home URL captured when the tab was added.
  const [navMap, setNavMap] = useState<Record<string, { url: string; title: string }>>({});
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<WebchatNav>('webchat:nav', (evt) => {
      const p = evt.payload;
      if (!p || !p.service) return;
      setNavMap((prev) => {
        const cur = prev[p.service];
        if (cur && cur.url === p.url && cur.title === p.title) return prev;
        return { ...prev, [p.service]: { url: p.url || cur?.url || '', title: p.title || cur?.title || '' } };
      });
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, []);

  // Per-service loading state → drives the favicon pulse. Mirrors the
  // subscription inside `EmbeddedWebChat`; two subscribers to the same
  // Tauri event is fine and keeps the sidebar decoupled from the main view.
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<{ service: string; state: string }>('webchat:loading', (evt) => {
      const { service, state } = evt.payload;
      setLoadingMap((prev) => ({ ...prev, [service]: state === 'start' }));
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, []);

  const [dragId, setDragId] = useState<string | null>(null);
  /// Current drop target under the cursor. `side` is 'before'|'after'
  /// depending on whether the pointer is in the top or bottom half of
  /// the target (or left/right for horizontal tile grid). Used to
  /// render an insertion-line indicator so the user can see exactly
  /// where the drop will land.
  const [dropTarget, setDropTarget] = useState<{ id: string; side: 'before' | 'after' } | null>(null);

  const handleReorder = useCallback(
    async (fromId: string, toId: string, side: 'before' | 'after' = 'before') => {
      const from = services.find((s) => s.id === fromId);
      const to = services.find((s) => s.id === toId);
      if (!from || !to) return;
      // Cross-section drop → flip pin on the dragged tab to match the
      // target section, then reorder. Lets users move a tab between
      // Pinned and Tabs with a single drag instead of forcing them
      // through the context menu.
      const adjusted: WebChatService[] =
        !!from.pinned !== !!to.pinned
          ? services.map((s) => (s.id === fromId ? { ...s, pinned: to.pinned } : s))
          : services;
      const next = reorderServices(adjusted, fromId, toId, side);
      if (next === services) return;
      await persistServices(next, 'reorder tabs');
    },
    [persistServices, services],
  );

  // Inline rename state. `renaming` is the id currently being edited; enter
  // commits, escape cancels.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const startRename = useCallback((svc: WebChatService) => {
    setRenaming(svc.id);
    setRenameDraft(svc.label);
  }, []);

  const commitRename = useCallback(async () => {
    if (!renaming) return;
    const draft = renameDraft.trim();
    const original = services.find((s) => s.id === renaming)?.label ?? '';
    if (draft && draft !== original) {
      await handleRenameService(renaming, draft);
    }
    setRenaming(null);
    setRenameDraft('');
  }, [handleRenameService, renameDraft, renaming, services]);

  // Drag-n-drop URL onto the sidebar → opens add dialog prefilled.
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const dropped =
        e.dataTransfer.getData('text/uri-list') ||
        e.dataTransfer.getData('text/plain') ||
        '';
      const firstLine = dropped.split(/\r?\n/).find((l) => !l.startsWith('#'))?.trim();
      if (firstLine && isEmbeddableUrl(firstLine)) {
        openAddDialog(firstLine);
      }
    },
    [openAddDialog],
  );

  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!contextMenu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  const pinnedServices = useMemo(() => services.filter((s) => s.pinned), [services]);
  const unpinnedServices = useMemo(() => services.filter((s) => !s.pinned), [services]);

  const sidebarWidth = collapsed ? 44 : 168;

  const isStale = useCallback(
    (svc: WebChatService): boolean => {
      if (svc.pinned) return false;
      if (storedActive === svc.id) return false;
      const last = lastUsed[svc.id];
      if (!last) return false;
      return Date.now() - last > STALE_AFTER_MS;
    },
    [lastUsed, storedActive],
  );

  const renderTab = (s: WebChatService) => {
    const active = storedActive === s.id;
    const isRenaming = renaming === s.id;
    const beingDragged = dragId === s.id;
    const loading = !!loadingMap[s.id];
    const stale = isStale(s);
    const nav = navMap[s.id];
    const faviconUrl = nav?.url || s.url;
    const labelTitle = collapsed
      ? `${s.label} — double-click to rename`
      : nav?.title
        ? `${nav.title} — double-click to rename`
        : 'Double-click to rename';

    const isDropTarget = dropTarget?.id === s.id && dragId && dragId !== s.id;
    const indicatorSide = isDropTarget ? dropTarget.side : null;

    return (
      <div
        key={s.id}
        draggable={!isRenaming}
        onDragStart={(e) => {
          setDragId(s.id);
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData(TAB_DRAG_MIME, s.id);
          e.dataTransfer.setData('text/plain', s.id);
        }}
        onDragEnd={() => {
          setDragId(null);
          setDropTarget(null);
        }}
        onDragOver={(e) => {
          if (!Array.from(e.dataTransfer.types).includes(TAB_DRAG_MIME)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'move';
          const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          const side: 'before' | 'after' =
            e.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
          setDropTarget((prev) =>
            prev && prev.id === s.id && prev.side === side ? prev : { id: s.id, side },
          );
        }}
        onDragLeave={(e) => {
          // Only clear when the pointer truly leaves this row (and not
          // onto one of its children) so the indicator doesn't flicker.
          if ((e.currentTarget as HTMLDivElement).contains(e.relatedTarget as Node)) return;
          setDropTarget((prev) => (prev?.id === s.id ? null : prev));
        }}
        onDrop={(e) => {
          const from = e.dataTransfer.getData(TAB_DRAG_MIME);
          const side = dropTarget?.id === s.id ? dropTarget.side : 'before';
          setDragId(null);
          setDropTarget(null);
          if (!from || from === s.id) return;
          e.preventDefault();
          e.stopPropagation();
          handleReorder(from, s.id, side).catch(() => {});
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setContextMenu({ id: s.id, x: e.clientX, y: e.clientY });
        }}
        className={`group relative flex items-center rounded-md transition-all ${
          active ? 'bg-white/[0.10]' : 'hover:bg-white/[0.04]'
        } ${beingDragged ? 'opacity-50' : ''} ${stale && !active ? 'opacity-60' : ''}`}
      >
        {isRenaming && !collapsed ? (
          <Input
            aria-label="Rename tab"
            autoFocus
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.currentTarget.value)}
            onBlur={() => {
              commitRename().catch(() => {});
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRename().catch(() => {});
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setRenaming(null);
              }
            }}
            className="h-7 flex-1 mx-1 text-meta"
          />
        ) : (
          <Tooltip label={labelTitle} side="right">
          <button
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => setActive(s.id)}
            onDoubleClick={() => {
              if (!collapsed) startRename(s);
            }}
            className={`flex items-center min-w-0 flex-1 rounded-md text-meta ${
              collapsed ? 'justify-center py-2' : 'gap-2 pl-2 pr-1 py-1.5'
            } ${active ? 't-primary' : 't-secondary'}`}
            aria-label={collapsed ? s.label : undefined}
          >
            <span className="relative shrink-0 inline-flex items-center justify-center w-[14px] h-[14px]">
              <Favicon url={faviconUrl} label={s.label} size={14} />
              {loading && (
                <span
                  aria-hidden="true"
                  className="absolute inset-[-3px] rounded-full pointer-events-none"
                  style={{
                    boxShadow: `0 0 0 1.5px ${accent(0.9)}`,
                    animation: 'stash-web-pulse 1.1s ease-in-out infinite',
                  }}
                />
              )}
            </span>
            {!collapsed && <span className="truncate">{s.label}</span>}
          </button>
          </Tooltip>
        )}
        {!isRenaming && !collapsed && (
          <>
            <Tooltip label="Copy URL (⌘⇧C)" side="right">
            <button
              type="button"
              aria-label={`Copy URL of ${s.label}`}
              onClick={(e) => {
                e.stopPropagation();
                copyServiceUrl(s).catch(() => {});
              }}
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 t-tertiary hover:t-primary px-1.5 py-1 rounded-md transition-opacity"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M3 12h18" />
                <path d="M12 3a10 10 0 0 1 0 18" />
                <path d="M12 3a10 10 0 0 0 0 18" />
              </svg>
            </button>
            </Tooltip>
            <Tooltip label={`Close ${s.label} (free RAM; reopens on click)`} side="right">
            <button
              type="button"
              aria-label={`Close ${s.label}`}
              onClick={(e) => {
                e.stopPropagation();
                closeService(s.id).catch(() => {});
              }}
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 t-tertiary hover:text-red-400 px-1.5 py-1 mr-0.5 rounded-md text-meta transition-opacity"
            >
              ×
            </button>
            </Tooltip>
          </>
        )}
        {indicatorSide && (
          <span
            aria-hidden="true"
            className="absolute left-1 right-1 h-0.5 rounded-full pointer-events-none"
            style={{
              background: accent(0.95),
              boxShadow: `0 0 6px ${accent(0.6)}`,
              top: indicatorSide === 'before' ? -1 : undefined,
              bottom: indicatorSide === 'after' ? -1 : undefined,
            }}
          />
        )}
      </div>
    );
  };

  const contextService = contextMenu
    ? services.find((s) => s.id === contextMenu.id) ?? null
    : null;

  return (
    <div ref={rootRef} className="flex flex-row h-full w-full" style={{ background: 'var(--color-scrim)' }}>
      <aside
        aria-label="Web services"
        className={`relative flex flex-col shrink-0 py-2 gap-0.5 border-r hair transition-[width,background] ${
          collapsed ? 'px-1' : 'px-1.5'
        } ${dragOver ? 'bg-white/[0.04]' : ''}`}
        style={{ width: sidebarWidth, background: 'var(--color-bg)' }}
        onDragOver={(e) => {
          const types = Array.from(e.dataTransfer.types);
          if (types.includes(TAB_DRAG_MIME)) return;
          if (types.some((t) => t === 'text/uri-list' || t === 'text/plain')) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={(e) => {
          // Only clear when the drag actually leaves the sidebar (not on
          // children) — otherwise the overlay flickers as we cross rows.
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setDragOver(false);
        }}
        onDrop={onDrop}
      >
        <Tooltip label="Home — all services" side="right">
        <button
          type="button"
          role="tab"
          aria-selected={storedActive === ''}
          onClick={() => setActive('')}
          className={`flex items-center rounded-md text-meta transition-colors ${
            collapsed ? 'justify-center py-2' : 'gap-2 px-2 py-1.5'
          } ${
            storedActive === ''
              ? 't-primary bg-white/[0.08]'
              : 't-secondary hover:t-primary hover:bg-white/[0.04]'
          }`}
          aria-label="Home"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            aria-hidden="true"
            className="shrink-0"
            style={{ color: 'rgb(var(--stash-accent-rgb))' }}
          >
            <rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1" fill="currentColor" opacity="0.9" />
            <rect x="8" y="1.5" width="4.5" height="4.5" rx="1" fill="currentColor" opacity="0.55" />
            <rect x="1.5" y="8" width="4.5" height="4.5" rx="1" fill="currentColor" opacity="0.55" />
            <rect x="8" y="8" width="4.5" height="4.5" rx="1" fill="currentColor" opacity="0.9" />
          </svg>
          {!collapsed && <span className="truncate">Home</span>}
        </button>
        </Tooltip>

        {pinnedServices.length > 0 && (
          <>
            {!collapsed && (
              <div className="mt-2 mb-1 px-2 text-[10px] uppercase tracking-wider t-tertiary">
                Pinned
              </div>
            )}
            {collapsed && (
              <div
                aria-hidden="true"
                className="h-px mx-2 mt-2 mb-1"
                style={{ background: 'var(--color-hairline)' }}
              />
            )}
            <div role="tablist" aria-label="Pinned tabs" className="flex flex-col gap-0.5">
              {pinnedServices.map(renderTab)}
            </div>
          </>
        )}

        {unpinnedServices.length > 0 && (
          <>
            {!collapsed && (
              <div
                className={`${pinnedServices.length > 0 ? 'mt-2' : 'mt-2'} mb-1 px-2 text-[10px] uppercase tracking-wider t-tertiary`}
              >
                Tabs
              </div>
            )}
            {collapsed && pinnedServices.length === 0 && (
              <div
                aria-hidden="true"
                className="h-px mx-2 mt-2 mb-1"
                style={{ background: 'var(--color-hairline)' }}
              />
            )}
            <div role="tablist" aria-label="Unpinned tabs" className="flex flex-col gap-0.5">
              {unpinnedServices.map(renderTab)}
            </div>
          </>
        )}

        <div className="flex-1" />

        <Tooltip label="Add web tab (or drop a URL onto the sidebar)" side="right">
        <button
          type="button"
          onClick={() => openAddDialog('')}
          className={`flex items-center rounded-md text-meta t-secondary hover:t-primary hover:bg-white/[0.04] transition-colors ${
            collapsed ? 'justify-center py-2' : 'gap-2 px-2 py-1.5'
          }`}
          aria-label="Add web tab"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            aria-hidden="true"
            className="shrink-0"
            style={{ color: 'rgb(var(--stash-accent-rgb))' }}
          >
            <circle cx="7" cy="7" r="6" fill="currentColor" opacity="0.18" />
            <path d="M7 3.5 V10.5 M3.5 7 H10.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          {!collapsed && <span className="truncate">New tab</span>}
        </button>
        </Tooltip>

        <Tooltip label={collapsed ? 'Expand sidebar (⌘S)' : 'Collapse sidebar (⌘S)'} side="right">
        <button
          type="button"
          onClick={toggleCollapsed}
          className={`flex items-center rounded-md text-meta t-tertiary hover:t-primary hover:bg-white/[0.04] transition-colors ${
            collapsed ? 'justify-center py-2' : 'gap-2 px-2 py-1.5'
          }`}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-pressed={collapsed}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className="shrink-0">
            <rect x="1.5" y="2" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <line x1="5" y1="2" x2="5" y2="12" stroke="currentColor" strokeWidth="1.2" />
            <path
              d={collapsed ? 'M8 5 L10.5 7 L8 9' : 'M10.5 5 L8 7 L10.5 9'}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {!collapsed && <span className="truncate">Collapse</span>}
        </button>
        </Tooltip>

        {dragOver && (
          <div
            aria-hidden="true"
            className="absolute inset-1 rounded-lg pointer-events-none flex items-center justify-center text-meta font-medium text-center px-2"
            style={{
              border: `1.5px dashed ${accent(0.9)}`,
              background: accent(0.12),
              color: 'rgb(var(--stash-accent-rgb))',
            }}
          >
            {collapsed ? '+' : 'Drop URL to add tab'}
          </div>
        )}
      </aside>

      <main className="flex-1 min-w-0 flex flex-col" style={{ background: 'var(--color-bg)' }}>
        {activeService ? (
          <EmbeddedWebChat
            key={activeService.id}
            service={activeService}
            onSaveAsTab={openAddDialog}
            onPinCurrentAsHome={(url) => {
              handlePinCurrentAsHome(activeService.id, url).catch(() => {});
            }}
            onZoomChange={(id, z) => {
              handleZoomChange(id, z).catch(() => {});
            }}
            suspended={addOpen}
          />
        ) : (
          <div className="flex-1 overflow-y-auto nice-scroll p-6">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 max-w-[720px] mx-auto">
              {services.length === 0 && (
                <div className="col-span-full t-tertiary text-meta text-center py-8">
                  No web tabs yet. Click + or drop a URL onto the sidebar.
                </div>
              )}
              {services.map((s) => {
                const nav = navMap[s.id];
                const effectiveUrl = nav?.url || s.url;
                let host = effectiveUrl;
                try {
                  host = new URL(effectiveUrl).hostname;
                } catch {
                  // keep raw URL on parse failure
                }
                const beingDragged = dragId === s.id;
                const isDropTarget = dropTarget?.id === s.id && dragId && dragId !== s.id;
                const indicatorSide = isDropTarget ? dropTarget.side : null;
                return (
                  <button
                    key={s.id}
                    type="button"
                    draggable
                    onClick={() => setActive(s.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setContextMenu({ id: s.id, x: e.clientX, y: e.clientY });
                    }}
                    onDragStart={(e) => {
                      setDragId(s.id);
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData(TAB_DRAG_MIME, s.id);
                      e.dataTransfer.setData('text/plain', s.id);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setDropTarget(null);
                    }}
                    onDragOver={(e) => {
                      if (!Array.from(e.dataTransfer.types).includes(TAB_DRAG_MIME)) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      // Tiles are a horizontal grid row — split on X, not Y.
                      const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                      const side: 'before' | 'after' =
                        e.clientX - rect.left < rect.width / 2 ? 'before' : 'after';
                      setDropTarget((prev) =>
                        prev && prev.id === s.id && prev.side === side
                          ? prev
                          : { id: s.id, side },
                      );
                    }}
                    onDragLeave={(e) => {
                      if ((e.currentTarget as HTMLButtonElement).contains(e.relatedTarget as Node))
                        return;
                      setDropTarget((prev) => (prev?.id === s.id ? null : prev));
                    }}
                    onDrop={(e) => {
                      const from = e.dataTransfer.getData(TAB_DRAG_MIME);
                      const side = dropTarget?.id === s.id ? dropTarget.side : 'before';
                      setDragId(null);
                      setDropTarget(null);
                      if (!from || from === s.id) return;
                      e.preventDefault();
                      handleReorder(from, s.id, side).catch(() => {});
                    }}
                    className={`group relative flex flex-col items-center gap-2 p-4 rounded-xl border hair hover:bg-white/[0.04] transition-colors text-center ${
                      beingDragged ? 'opacity-50' : ''
                    }`}
                    style={{ background: 'var(--color-surface)' }}
                  >
                    <Favicon url={effectiveUrl} label={s.label} size={40} className="!rounded-md" />
                    <div className="t-primary text-body font-medium">{s.label}</div>
                    <div className="t-tertiary text-meta truncate max-w-full">{host}</div>
                    {indicatorSide && (
                      <span
                        aria-hidden="true"
                        className="absolute top-1 bottom-1 w-0.5 rounded-full pointer-events-none"
                        style={{
                          background: accent(0.95),
                          boxShadow: `0 0 6px ${accent(0.6)}`,
                          left: indicatorSide === 'before' ? -2 : undefined,
                          right: indicatorSide === 'after' ? -2 : undefined,
                        }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </main>

      {contextMenu && contextService && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`Actions for ${contextService.label}`}
          className="fixed z-30 min-w-[180px] rounded-md border hair py-1 shadow-lg"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 200),
            top: Math.min(contextMenu.y, window.innerHeight - 280),
            background: 'var(--color-surface)',
          }}
        >
          <ContextMenuItem
            onClick={() => {
              startRename(contextService);
              setContextMenu(null);
            }}
          >
            Rename
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              duplicateService(contextService.id).catch(() => {});
              setContextMenu(null);
            }}
          >
            Duplicate
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              togglePin(contextService.id).catch(() => {});
              setContextMenu(null);
            }}
          >
            {contextService.pinned ? 'Unpin' : 'Pin'}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              copyServiceUrl(contextService).catch(() => {});
              setContextMenu(null);
            }}
          >
            Copy URL <span className="t-tertiary text-[10.5px] font-mono ml-2">⌘⇧C</span>
          </ContextMenuItem>
          <div className="h-px my-1 mx-1" style={{ background: 'var(--color-hairline)' }} />
          <ContextMenuItem
            onClick={() => {
              closeService(contextService.id).catch(() => {});
              setContextMenu(null);
            }}
          >
            Close (free RAM)
          </ContextMenuItem>
          <ContextMenuItem
            disabled={services.length < 2}
            onClick={() => {
              closeOthers(contextService.id).catch(() => {});
              setContextMenu(null);
            }}
          >
            Close others
          </ContextMenuItem>
          <div className="h-px my-1 mx-1" style={{ background: 'var(--color-hairline)' }} />
          <ContextMenuItem
            danger
            onClick={() => {
              deleteService(contextService.id).catch(() => {});
              setContextMenu(null);
            }}
          >
            Delete tab
          </ContextMenuItem>
        </div>
      )}

      <AddWebServiceModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        existing={services}
        initialUrl={addPrefillUrl}
        title={addPrefillUrl ? 'Save URL as tab' : 'Add web tab'}
        onAdd={(svc) => {
          handleAddService(svc).catch(() => {});
        }}
      />
    </div>
  );
};

const ContextMenuItem = ({
  onClick,
  danger,
  disabled,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    role="menuitem"
    disabled={disabled}
    onClick={onClick}
    className={`w-full text-left px-3 py-1.5 text-meta transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
      danger
        ? 't-secondary hover:text-red-400 hover:bg-white/[0.04]'
        : 't-secondary hover:t-primary hover:bg-white/[0.04]'
    }`}
  >
    {children}
  </button>
);
