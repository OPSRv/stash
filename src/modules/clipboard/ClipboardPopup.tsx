import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSuppressibleConfirm } from '../../shared/hooks/useSuppressibleConfirm';
import { convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Kbd } from '../../shared/ui/Kbd';
import { IconButton } from '../../shared/ui/IconButton';
import { Button } from '../../shared/ui/Button';
import { Card } from '../../shared/ui/Card';
import { Row } from '../../shared/ui/Row';
import { SearchInput } from '../../shared/ui/SearchInput';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { AskAiButton } from '../../shared/ui/AskAiButton';
import { SendToTranslatorButton } from '../../shared/ui/SendToTranslatorButton';
import { ExternalIcon, EyeIcon, NoteIcon, PinIcon, TrashIcon } from '../../shared/ui/icons';
import { useToast } from '../../shared/ui/Toast';
import { useAnnounce } from '../../shared/ui/LiveRegion';
import { useKeyboardNav } from '../../shared/hooks/useKeyboardNav';
import type { ClipboardItem } from './api';
import {
  clearAll,
  copyOnly,
  deleteItem,
  listItems,
  parseImageMeta,
  pasteItem,
  searchItems,
  togglePin,
} from './api';
import { detectType, type ContentType } from './contentType';
import { iconFor, typeTint } from './icons';
import { ClipboardVirtualList } from './ClipboardVirtualList';
import { LinkRow } from './LinkRow';
import { detect as detectVideo, start as startDownload, type DetectedVideo } from '../downloader/api';
import { PlatformBadge } from '../downloader/PlatformBadge';
import { notesCreate } from '../notes/api';
import { PreviewDialog } from './PreviewDialog';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

const iso = (ts: number) => {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
};

type Filter = 'all' | ContentType;

const filters: { id: Filter; label: string; hint: string }[] = [
  { id: 'all', label: 'All', hint: '⌘1' },
  { id: 'text', label: 'Text', hint: '⌘2' },
  { id: 'image', label: 'Images', hint: '⌘3' },
  { id: 'link', label: 'Links', hint: '⌘4' },
];

const PREVIEW_MIN_CHARS = 280;
const PREVIEW_MIN_LINES = 4;
const isLongText = (s: string) =>
  s.length >= PREVIEW_MIN_CHARS || s.split('\n').length >= PREVIEW_MIN_LINES;

export const ClipboardPopup = () => {
  const [rawItems, setRawItems] = useState<ClipboardItem[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [reloadNonce, setReloadNonce] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [videoBanner, setVideoBanner] = useState<DetectedVideo | null>(null);
  const [videoBannerUrl, setVideoBannerUrl] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null);
  const [copyFlash, setCopyFlash] = useState(false);
  const copyFlashTimer = useRef<number | null>(null);
  const [newItemId, setNewItemId] = useState<number | null>(null);
  const newItemTimer = useRef<number | null>(null);
  const seenIdsRef = useRef<Set<number> | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const deleteConfirm = useSuppressibleConfirm<number>('clipboard.delete');
  const [previewId, setPreviewId] = useState<number | null>(null);
  const { toast } = useToast();
  const { announce } = useAnnounce();

  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    const trimmed = query.trim();
    // Bare list() / change events apply immediately; only typed search is
    // debounced to avoid an IPC round-trip per keystroke.
    const delay = trimmed ? 120 : 0;
    const timer = window.setTimeout(() => {
      const load = trimmed ? searchItems(trimmed) : listItems();
      load.then((data) => {
        if (!cancelled) setRawItems(data);
      });
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, reloadNonce]);

  // Coalesce bursts of clipboard changes (e.g. user copy-spamming) into a
  // single list refresh so we don't hammer SQLite + React with an IPC round
  // trip per event. 120ms is below the perception threshold for "instant".
  useEffect(() => {
    let pending: number | null = null;
    const unlisten = listen('clipboard:changed', () => {
      if (pending !== null) return;
      pending = window.setTimeout(() => {
        pending = null;
        reload();
      }, 120);
    });
    return () => {
      if (pending !== null) window.clearTimeout(pending);
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [reload]);

  useEffect(
    () => () => {
      if (copyFlashTimer.current !== null) window.clearTimeout(copyFlashTimer.current);
      if (newItemTimer.current !== null) window.clearTimeout(newItemTimer.current);
    },
    [],
  );

  // Track the freshest id that wasn't in the prior list so the matching row
  // can play an entrance animation. Skip the *first non-empty* load — the
  // initial `rawItems` is `[]` before IPC resolves, so seeding on mount
  // would mark every real item as "fresh" and flash the whole pane.
  useEffect(() => {
    if (seenIdsRef.current === null) {
      if (rawItems.length === 0) return;
      seenIdsRef.current = new Set(rawItems.map((i) => i.id));
      return;
    }
    const seen = seenIdsRef.current;
    const fresh = rawItems.find((i) => !seen.has(i.id));
    rawItems.forEach((i) => seen.add(i.id));
    if (!fresh) return;
    setNewItemId(fresh.id);
    if (newItemTimer.current !== null) window.clearTimeout(newItemTimer.current);
    newItemTimer.current = window.setTimeout(() => {
      setNewItemId(null);
      newItemTimer.current = null;
    }, 600);
    setCopyFlash(true);
    if (copyFlashTimer.current !== null) window.clearTimeout(copyFlashTimer.current);
    copyFlashTimer.current = window.setTimeout(() => {
      setCopyFlash(false);
      copyFlashTimer.current = null;
    }, 450);
  }, [rawItems]);


  // Auto-detect video downloads when the newest text item is a video URL.
  // Depend only on the newest text item's identity — re-running this effect
  // on every progress tick / metadata refresh would cancel an in-flight
  // detect for a URL that hasn't actually changed.
  const newestText = useMemo(
    () => rawItems.find((i) => i.kind === 'text') ?? null,
    [rawItems]
  );
  useEffect(() => {
    if (!newestText) {
      setVideoBanner(null);
      setVideoBannerUrl(null);
      return;
    }
    const candidate = newestText.content.trim();
    const supported = /https?:\/\/(www\.)?(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|twitter\.com|x\.com|reddit\.com|vimeo\.com|twitch\.tv|facebook\.com|fb\.watch)/i.test(
      candidate
    );
    if (!supported || candidate === videoBannerUrl) return;
    setVideoBannerUrl(candidate);
    setVideoBanner(null);
    let cancelled = false;
    detectVideo(candidate)
      .then((d) => {
        if (!cancelled) setVideoBanner(d);
      })
      .catch((e) => {
        if (!cancelled) console.warn('dl_detect failed:', e);
      });
    return () => {
      cancelled = true;
    };
  }, [newestText?.id, newestText?.content, videoBannerUrl]);

  const downloadFromBanner = async (
    kind: 'video' | 'audio',
    formatId?: string,
    height?: number | null
  ) => {
    if (!videoBanner || !videoBannerUrl) return;
    try {
      await startDownload({
        url: videoBannerUrl,
        title: videoBanner.info.title,
        thumbnail: videoBanner.info.thumbnail,
        format_id: formatId ?? null,
        height: height ?? null,
        kind,
      });
      setVideoBanner(null);
    } catch (e) {
      console.error('start download failed:', e);
    }
  };

  const typed = useMemo(
    () =>
      rawItems.map((i) => ({
        ...i,
        type: (i.kind === 'image' ? 'image' : detectType(i.content)) as ContentType,
      })),
    [rawItems]
  );

  const items = useMemo(
    () => (filter === 'all' ? typed : typed.filter((i) => i.type === filter)),
    [typed, filter]
  );

  const { pinned, recent } = useMemo(
    () => ({
      pinned: items.filter((i) => i.pinned),
      recent: items.filter((i) => !i.pinned),
    }),
    [items]
  );

  const flat = useMemo(() => [...pinned, ...recent], [pinned, recent]);

  const pasteAt = useCallback(
    (i: number) => {
      const item = flat[i];
      if (!item) return;
      pasteItem(item.id)
        .then(() => announce('Pasted'))
        .catch((e) => console.error('paste failed:', e));
    },
    [flat, announce]
  );

  const copyAt = useCallback(
    (i: number) => {
      const item = flat[i];
      if (!item) return;
      copyOnly(item.id)
        .then(() => {
          announce('Copied to clipboard');
          toast({ title: 'Copied', variant: 'success', durationMs: 2000 });
          getCurrentWindow().hide().catch(() => {});
        })
        .catch((e) => {
          console.error('copy failed:', e);
          toast({ title: 'Copy failed', description: String(e), variant: 'error' });
        });
    },
    [flat, toast, announce]
  );

  const onSelect = useCallback(
    (i: number) => pasteAt(i),
    [pasteAt]
  );

  const bumpItemToTop = useCallback((id: number) => {
    setRawItems((prev) => {
      const target = prev.find((p) => p.id === id);
      if (!target) return prev;
      const rest = prev.filter((p) => p.id !== id);
      const nowSec = Math.floor(Date.now() / 1000);
      const bumped = { ...target, created_at: nowSec };
      if (bumped.pinned) return [bumped, ...rest];
      const firstUnpinned = rest.findIndex((p) => !p.pinned);
      return firstUnpinned === -1
        ? [...rest, bumped]
        : [...rest.slice(0, firstUnpinned), bumped, ...rest.slice(firstUnpinned)];
    });
  }, []);

  // Clicking a row copies to the system clipboard and shows a visible toast,
  // leaving the popup open — paste (and auto-hide) stays on Enter / ⇧Enter.
  const copyInPlace = useCallback(
    (i: number) => {
      const item = flat[i];
      if (!item) return;
      bumpItemToTop(item.id);
      announce('Copied to clipboard');
      toast({ title: 'Copied', variant: 'success', durationMs: 1600 });
      copyOnly(item.id).catch((e) => {
        console.error('copy failed:', e);
        toast({ title: 'Copy failed', description: String(e), variant: 'error' });
        reload();
      });
    },
    [flat, toast, announce, bumpItemToTop, reload],
  );

  const { index, setIndex } = useKeyboardNav({
    itemCount: flat.length,
    onSelect,
  });

  const handleTogglePin = useCallback(
    (id: number) => {
      const target = rawItems.find((i) => i.id === id);
      togglePin(id)
        .then(() => {
          reload();
          announce(target?.pinned ? 'Unpinned' : 'Pinned');
        })
        .catch((e) => console.error('togglePin failed:', e));
    },
    [reload, rawItems, announce]
  );

  const performDelete = useCallback(
    (id: number) => {
      deleteItem(id)
        .then(() => {
          reload();
          announce('Item deleted');
        })
        .catch((e) => {
          console.error('delete failed:', e);
          toast({ title: 'Delete failed', description: String(e), variant: 'error' });
        });
    },
    [reload, toast, announce]
  );

  const handleDelete = useCallback(
    (id: number) => {
      deleteConfirm.request(id, performDelete);
    },
    [deleteConfirm, performDelete]
  );

  const handleClearAll = useCallback(() => {
    setClearConfirmOpen(true);
  }, []);

  const previewItem = useMemo(
    () => (previewId == null ? null : rawItems.find((i) => i.id === previewId) ?? null),
    [previewId, rawItems]
  );

  const closePreview = useCallback(() => setPreviewId(null), []);

  const handlePreviewCopy = useCallback(async () => {
    if (!previewItem) return;
    try {
      await writeText(previewItem.content);
      toast({ title: 'Copied', variant: 'success', durationMs: 2000 });
    } catch (e) {
      console.error('copy failed:', e);
      toast({ title: 'Copy failed', description: String(e), variant: 'error' });
    }
  }, [previewItem, toast]);

  const saveTextToNote = useCallback(
    async (body: string) => {
      const firstLine = body.split('\n').find((l) => l.trim().length > 0) ?? '';
      const title = firstLine.length > 60 ? `${firstLine.slice(0, 57).trimEnd()}…` : firstLine;
      try {
        await notesCreate(title, body);
        toast({
          title: 'Saved to notes',
          variant: 'success',
          action: {
            label: 'Open Notes',
            onClick: () =>
              window.dispatchEvent(new CustomEvent('stash:navigate', { detail: 'notes' })),
          },
        });
      } catch (e) {
        console.error('save to note failed:', e);
        toast({ title: 'Save failed', description: String(e), variant: 'error' });
      }
    },
    [toast],
  );

  const handleSaveToNote = useCallback(async () => {
    if (!previewItem) return;
    await saveTextToNote(previewItem.content);
    setPreviewId(null);
  }, [previewItem, saveTextToNote]);

  const openImageInViewer = useCallback(
    async (path: string) => {
      try {
        const { openPath } = await import('@tauri-apps/plugin-opener');
        await openPath(path);
      } catch (e) {
        console.error('open image failed:', e);
        toast({ title: 'Could not open image', description: String(e), variant: 'error' });
      }
    },
    [toast],
  );

  const handleRowSaveToNote = useCallback(
    (id: number) => {
      const item = rawItems.find((i) => i.id === id);
      if (!item || item.kind !== 'text') return;
      void saveTextToNote(item.content);
    },
    [rawItems, saveTextToNote],
  );

  const confirmClearAll = useCallback(() => {
    setClearConfirmOpen(false);
    clearAll()
      .then(() => {
        reload();
        toast({ title: 'History cleared', variant: 'success' });
      })
      .catch((e) => {
        console.error('clearAll failed:', e);
        toast({ title: 'Clear failed', description: String(e), variant: 'error' });
      });
  }, [reload, toast]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectionAnchor(null);
  }, []);

  const handleRowClick = useCallback(
    (flatIndex: number, e?: React.MouseEvent) => {
      const item = flat[flatIndex];
      if (!item) return;
      if (e?.shiftKey && selectionAnchor !== null) {
        e.preventDefault();
        const [from, to] =
          flatIndex < selectionAnchor
            ? [flatIndex, selectionAnchor]
            : [selectionAnchor, flatIndex];
        const next = new Set<number>();
        for (let i = from; i <= to; i++) {
          const it = flat[i];
          if (it) next.add(it.id);
        }
        setSelectedIds(next);
        return;
      }
      if (e?.metaKey || e?.ctrlKey) {
        e.preventDefault();
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(item.id)) next.delete(item.id);
          else next.add(item.id);
          return next;
        });
        setSelectionAnchor(flatIndex);
        return;
      }
      // Plain click: clear multi-selection, copy to clipboard, and leave the
      // popup open so the user actually sees the confirmation toast. Paste
      // remains bound to Enter / ⇧Enter.
      clearSelection();
      copyInPlace(flatIndex);
      // Item has moved to the top of its section — follow it with the
      // keyboard cursor so the ↵ hint stays on the clicked row.
      setIndex(item.pinned ? 0 : pinned.length);
    },
    [flat, selectionAnchor, clearSelection, setIndex, copyInPlace, pinned.length]
  );

  const bulkDelete = useCallback(async () => {
    const ids = [...selectedIds];
    try {
      await Promise.all(ids.map((id) => deleteItem(id)));
      clearSelection();
      reload();
    } catch (e) {
      console.error('bulk delete failed', e);
    }
  }, [selectedIds, clearSelection, reload]);

  const bulkPin = useCallback(async () => {
    const ids = [...selectedIds];
    try {
      await Promise.all(ids.map((id) => togglePin(id)));
      clearSelection();
      reload();
    } catch (e) {
      console.error('bulk pin failed', e);
    }
  }, [selectedIds, clearSelection, reload]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        setFilter(filters[Number(e.key) - 1].id);
        return;
      }
      if (e.metaKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === 'Escape') {
        if (selectedIds.size > 0) {
          e.preventDefault();
          clearSelection();
          return;
        }
        if (query) {
          e.preventDefault();
          setQuery('');
          return;
        }
      }
      if (e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        copyAt(index);
        return;
      }
      const item = flat[index];
      if (!item) return;
      // Include TEXTAREA and contentEditable hosts so keystrokes meant for
      // composers in other tabs (chat, notes) don't trigger clipboard
      // list commands via this window-level listener.
      const target = e.target as HTMLElement | null;
      const typingInInput =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true;
      if (e.metaKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        handleTogglePin(item.id);
      } else if (e.key === ' ' && !typingInInput && item.kind === 'text') {
        e.preventDefault();
        setPreviewId(item.id);
      } else if (e.key === 'Backspace' && !typingInInput) {
        e.preventDefault();
        handleDelete(item.id);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [flat, index, query, copyAt, handleTogglePin, handleDelete, selectedIds, clearSelection]);

  const totalBytes = useMemo(
    () => typed.reduce((sum, i) => sum + i.content.length, 0),
    [typed]
  );
  const formatBytes = (n: number) =>
    n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

  const renderRow = (item: (typeof typed)[number], flatIndex: number) => {
    const enterClass = item.id === newItemId ? 'clip-row-enter' : undefined;
    if (item.type === 'link') {
      return (
        <LinkRow
          key={item.id}
          item={item}
          flatIndex={flatIndex}
          active={index === flatIndex}
          selected={selectedIds.has(item.id)}
          onTogglePin={handleTogglePin}
          onDelete={handleDelete}
          onClick={handleRowClick}
          onSaveToNote={handleRowSaveToNote}
          className={enterClass}
        />
      );
    }
    const tint = typeTint[item.type];
    const imageMeta = item.kind === 'image' ? parseImageMeta(item) : null;
    const icon = imageMeta ? (
      <img
        src={convertFileSrc(imageMeta.path)}
        alt=""
        className="w-7 h-7 rounded-md object-cover"
      />
    ) : (
      iconFor(item.type)
    );
    const primary = imageMeta ? `Image · ${imageMeta.w}×${imageMeta.h}` : item.content;
    return (
      <Row
        key={item.id}
        primary={primary}
        icon={icon}
        iconTint={imageMeta ? 'transparent' : tint.bg}
        iconColor={tint.fg}
        actions={
          <>
            {item.kind === 'text' && isLongText(item.content) && (
              <IconButton
                onClick={() => setPreviewId(item.id)}
                title="Preview (Space)"
              >
                <EyeIcon size={12} />
              </IconButton>
            )}
            {imageMeta && (
              <IconButton
                onClick={() => openImageInViewer(imageMeta.path)}
                title="Open in image viewer"
              >
                <ExternalIcon size={12} />
              </IconButton>
            )}
            {item.kind === 'text' && (
              <>
                <SendToTranslatorButton text={item.content} />
                <AskAiButton text={item.content} />
                <IconButton onClick={() => handleRowSaveToNote(item.id)} title="Save to notes">
                  <NoteIcon size={12} />
                </IconButton>
              </>
            )}
            <IconButton onClick={() => handleTogglePin(item.id)} title={item.pinned ? 'Unpin' : 'Pin'}>
              <PinIcon size={12} filled={item.pinned} />
            </IconButton>
            <IconButton onClick={() => handleDelete(item.id)} title="Delete" tone="danger">
              <TrashIcon size={12} />
            </IconButton>
          </>
        }
        meta={
          <>
            <span className="t-tertiary text-meta font-mono">{iso(item.created_at)}</span>
            {index === flatIndex && <Kbd>↵</Kbd>}
          </>
        }
        pinned={item.pinned}
        active={index === flatIndex}
        selected={selectedIds.has(item.id)}
        onSelect={(e) => handleRowClick(flatIndex, e)}
        className={enterClass}
      />
    );
  };

  const isEmpty = flat.length === 0;

  const selectionCount = selectedIds.size;

  return (
    <div
      className={`flex flex-col h-full relative${copyFlash ? ' clip-flash' : ''}`}
    >
      {selectionCount > 0 && (
        <div
          className="px-3 py-2 flex items-center justify-between border-b hair"
          style={{ background: 'rgba(var(--stash-accent-rgb),0.08)' }}
        >
          <span className="t-primary text-meta font-medium">
            {selectionCount} selected
          </span>
          <div className="flex items-center gap-2">
            <Button size="xs" onClick={bulkPin}>
              Pin
            </Button>
            <Button size="xs" variant="soft" tone="danger" onClick={bulkDelete}>
              Delete
            </Button>
            <Button size="xs" variant="ghost" onClick={clearSelection}>
              Clear
            </Button>
          </div>
        </div>
      )}
      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder="Search clipboard"
        shortcutHint="⌘K"
        inputRef={searchRef}
      />

      {videoBanner && (
        <Card tone="accent" padding="sm" rounded="lg" className="mx-2 mt-2 flex items-center gap-2">
          <div className="w-10 h-7 rounded overflow-hidden shrink-0 bg-black/50">
            {videoBanner.info.thumbnail && (
              <img src={videoBanner.info.thumbnail} alt="" className="w-full h-full object-cover" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-0.5">
              <PlatformBadge platform={videoBanner.platform} />
              <span className="t-primary text-meta font-medium truncate">Download this video</span>
            </div>
            <div className="t-tertiary text-[11px] truncate">{videoBanner.info.title}</div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {videoBanner.qualities.slice(0, 3).map((q) => (
              <Button
                key={q.format_id}
                size="sm"
                variant="soft"
                tone="accent"
                onClick={() => downloadFromBanner(q.kind, q.format_id, q.height)}
              >
                {q.label}
              </Button>
            ))}
          </div>
          <Button
            size="sm"
            variant="ghost"
            shape="square"
            aria-label="Dismiss"
            onClick={() => {
              setVideoBanner(null);
              setVideoBannerUrl(null);
            }}
          >
            ×
          </Button>
        </Card>
      )}

      <ClipboardVirtualList
        empty={isEmpty}
        query={query}
        pinned={pinned}
        recent={recent}
        renderRow={renderRow}
      />

      <footer
        className="flex items-center justify-between px-3 py-2 border-t hair"
        style={{ background: 'var(--color-scrim-soft)' }}
      >
        <div className="flex items-center gap-1">
          {filters.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`h-7 px-2.5 rounded-md flex items-center gap-1.5 text-meta font-medium ring-focus-sm transition-colors duration-150 ${
                filter === f.id
                  ? 't-primary bg-[var(--color-surface-raised)]'
                  : 't-secondary hover:bg-[var(--color-surface-raised)]'
              }`}
            >
              <Kbd>{f.hint}</Kbd>
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="t-tertiary text-meta">
            {typed.length} items · {formatBytes(totalBytes)}
          </span>
          <Button size="xs" onClick={handleClearAll} title="Clear all unpinned items">
            Clear
          </Button>
        </div>
      </footer>
      <ConfirmDialog
        open={clearConfirmOpen}
        title="Clear clipboard history?"
        description="Unpinned items will be removed. Pinned items will stay."
        confirmLabel="Clear"
        tone="danger"
        onConfirm={confirmClearAll}
        onCancel={() => setClearConfirmOpen(false)}
      />
      <ConfirmDialog
        open={deleteConfirm.open}
        title="Delete this item?"
        description="This cannot be undone."
        confirmLabel="Delete"
        tone="danger"
        suppressibleLabel="Don't ask again"
        onConfirm={(suppress) => deleteConfirm.confirm(!!suppress)}
        onCancel={deleteConfirm.cancel}
      />
      <PreviewDialog
        open={previewItem !== null && previewItem.kind === 'text'}
        text={previewItem?.content ?? ''}
        onClose={closePreview}
        onCopy={handlePreviewCopy}
        onSaveToNote={handleSaveToNote}
      />
    </div>
  );
};
