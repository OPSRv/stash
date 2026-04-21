import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { saveSetting, type WebChatService } from '../../settings/store';
import { Input } from '../../shared/ui/Input';
import { useToast } from '../../shared/ui/Toast';

import { AddWebServiceModal } from './AddWebServiceModal';
import { EmbeddedWebChat } from './EmbeddedWebChat';
import { useWebServices } from './useWebServices';
import { isEmbeddableUrl, reorderServices } from './webServiceUtils';
import { faviconUrlFor, webchatClose, webchatHideAll } from './webchatApi';

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

/// Host for the web-tab feature. Tabs along the top, tile picker when nothing
/// is selected, embedded native webview when a service is active. Mirrors the
/// pre-split AI tab's web mode one-for-one so muscle memory survives.
export const WebShell = () => {
  const services = useWebServices();
  const { toast } = useToast();

  const [storedActive, setStoredActive] = useState<string>(() => {
    try {
      return localStorage.getItem(LAST_TAB_KEY) ?? '';
    } catch {
      return '';
    }
  });

  const setActive = useCallback((next: string) => {
    setStoredActive(next);
    try {
      localStorage.setItem(LAST_TAB_KEY, next);
    } catch {
      // ignore
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

  // Host-side ⌘W when the React tree has focus (URL bar, toolbar buttons).
  // The injected script covers the case where the native webview is focused
  // instead — this branch is the complement, not a duplicate.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.key.toLowerCase() !== 'w' || !storedActive) return;
      e.preventDefault();
      closeService(storedActive).catch(() => {});
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeService, storedActive]);

  const [dragId, setDragId] = useState<string | null>(null);

  const handleReorder = useCallback(
    async (fromId: string, toId: string) => {
      const next = reorderServices(services, fromId, toId);
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

  // Drag-n-drop URL onto the tab bar → opens add dialog prefilled.
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

  const tabBarRef = useRef<HTMLDivElement | null>(null);

  return (
    <div className="flex flex-col h-full w-full" style={{ background: 'var(--color-bg)' }}>
      <div
        ref={tabBarRef}
        className={`px-3 py-2 border-b hair flex items-center gap-2 transition-colors ${
          dragOver ? 'bg-white/[0.06]' : ''
        }`}
        onDragOver={(e) => {
          const types = Array.from(e.dataTransfer.types);
          // A tab-reorder drag carries our own MIME — treat it as a move
          // inside the bar, not a URL drop that would spawn the add modal.
          if (types.includes(TAB_DRAG_MIME)) return;
          if (types.some((t) => t === 'text/uri-list' || t === 'text/plain')) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <div role="tablist" aria-label="Web services" className="flex items-center gap-1 flex-wrap">
          <button
            type="button"
            role="tab"
            aria-selected={storedActive === ''}
            onClick={() => setActive('')}
            className={`w-7 h-7 rounded-md flex items-center justify-center transition-colors ${
              storedActive === ''
                ? 't-primary bg-white/[0.08]'
                : 't-secondary hover:bg-white/[0.04]'
            }`}
            title="Show all services"
            aria-label="Show all services"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <rect x="8" y="1.5" width="4.5" height="4.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <rect x="1.5" y="8" width="4.5" height="4.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <rect x="8" y="8" width="4.5" height="4.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
          {services.map((s) => {
            const active = storedActive === s.id;
            const favicon = faviconUrlFor(s.url, 16);
            const isRenaming = renaming === s.id;
            const beingDragged = dragId === s.id;
            return (
              <div
                key={s.id}
                draggable={!isRenaming}
                onDragStart={(e) => {
                  setDragId(s.id);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData(TAB_DRAG_MIME, s.id);
                  // Also fill text/plain so external consumers get a
                  // useful fallback, but with the id — not the URL — so
                  // we don't accidentally look like a URL drop.
                  e.dataTransfer.setData('text/plain', s.id);
                }}
                onDragEnd={() => setDragId(null)}
                onDragOver={(e) => {
                  if (Array.from(e.dataTransfer.types).includes(TAB_DRAG_MIME)) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = 'move';
                  }
                }}
                onDrop={(e) => {
                  const from = e.dataTransfer.getData(TAB_DRAG_MIME);
                  if (!from || from === s.id) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setDragId(null);
                  handleReorder(from, s.id).catch(() => {});
                }}
                className={`group flex items-center rounded-md transition-colors ${
                  active ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]'
                } ${beingDragged ? 'opacity-50' : ''}`}
              >
                {isRenaming ? (
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
                    className="h-6 w-[120px] text-meta"
                  />
                ) : (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setActive(s.id)}
                    onDoubleClick={() => startRename(s)}
                    className={`flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-md text-meta ${
                      active ? 't-primary' : 't-secondary'
                    }`}
                    title="Double-click to rename"
                  >
                    {favicon && (
                      <img
                        src={favicon}
                        alt=""
                        width={14}
                        height={14}
                        className="rounded-sm"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                        }}
                      />
                    )}
                    <span>{s.label}</span>
                  </button>
                )}
                {!isRenaming && (
                  <button
                    type="button"
                    aria-label={`Close ${s.label}`}
                    title={`Close ${s.label} (free RAM; reopens on click)`}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeService(s.id).catch(() => {});
                    }}
                    className="opacity-0 group-hover:opacity-100 focus:opacity-100 t-tertiary hover:text-red-400 px-1 py-0.5 rounded-md text-meta transition-opacity"
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => openAddDialog('')}
            className="w-7 h-7 rounded-md flex items-center justify-center t-secondary hover:t-primary hover:bg-white/[0.04] transition-colors"
            title="Add web tab (or drop a URL here)"
            aria-label="Add web tab"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M7 2.5 V11.5 M2.5 7 H11.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="flex-1" />
      </div>
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
                No web tabs yet. Click + or drop a URL onto the tab bar.
              </div>
            )}
            {services.map((s) => {
              const favicon = faviconUrlFor(s.url, 64);
              let host = s.url;
              try {
                host = new URL(s.url).hostname;
              } catch {
                // keep raw URL on parse failure
              }
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setActive(s.id)}
                  className="group flex flex-col items-center gap-2 p-4 rounded-xl border hair hover:bg-white/[0.04] transition-colors text-center"
                  style={{ background: 'var(--color-surface)' }}
                >
                  {favicon ? (
                    <img
                      src={favicon}
                      alt=""
                      width={40}
                      height={40}
                      className="rounded-md"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                      }}
                    />
                  ) : (
                    <div
                      className="w-10 h-10 rounded-md flex items-center justify-center t-primary font-semibold"
                      style={{ background: 'rgba(var(--stash-accent-rgb), 0.18)' }}
                    >
                      {s.label.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div className="t-primary text-body font-medium">{s.label}</div>
                  <div className="t-tertiary text-meta truncate max-w-full">{host}</div>
                </button>
              );
            })}
          </div>
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
