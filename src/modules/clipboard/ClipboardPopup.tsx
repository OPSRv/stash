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
import {
  CopyIcon,
  ExternalIcon,
  EyeIcon,
  NoteIcon,
  PinIcon,
  TrashIcon,
} from '../../shared/ui/icons';
import { useToast } from '../../shared/ui/Toast';
import { useAnnounce } from '../../shared/ui/LiveRegion';
import { useKeyboardNav } from '../../shared/hooks/useKeyboardNav';
import type { ClipboardItem } from './api';
import {
  clearAll,
  copyOnly,
  deleteItem,
  listItems,
  parseFileMeta,
  parseImageMeta,
  pasteItem,
  pruneFiles,
  searchItems,
  togglePin,
} from './api';
import { detectFileKind } from '../../shared/util/fileKind';
import {
  detectTextSubtype,
  detectType,
  maskSecret,
  prettyJson,
  type ContentType,
  type TextSubtype,
} from './contentType';
import {
  BraceIcon,
  EmailIcon,
  FolderPathIcon,
  HashIcon,
  LockIcon,
  PhoneIcon,
  iconFor,
  subtypeVisual,
  typeTint,
} from './icons';
import { ClipboardVirtualList } from './ClipboardVirtualList';
import { LinkRow } from './LinkRow';
import { detect as detectVideo, start as startDownload, type DetectedVideo } from '../downloader/api';
import { PlatformBadge } from '../downloader/PlatformBadge';
import { notesCreate } from '../notes/api';
import { PreviewDialog } from './PreviewDialog';
import { FilePreviewDialog } from './FilePreviewDialog';
import { ContextMenu, type ContextMenuItem } from '../../shared/ui/ContextMenu';
import { accent } from '../../shared/theme/accent';
import { copyText } from '../../shared/util/clipboard';

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
  { id: 'file', label: 'Files', hint: '⌘5' },
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
  const [filePreviewId, setFilePreviewId] = useState<number | null>(null);
  const [revealedSecrets, setRevealedSecrets] = useState<Set<number>>(() => new Set());
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; id: number } | null>(null);
  const secretClearTimer = useRef<number | null>(null);
  const toggleReveal = useCallback((id: number) => {
    setRevealedSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const { toast } = useToast();
  const { announce } = useAnnounce();

  const SECRET_CLEAR_MS = 60_000;
  useEffect(
    () => () => {
      if (secretClearTimer.current !== null)
        window.clearTimeout(secretClearTimer.current);
    },
    [],
  );

  /// After a secret-subtype row lands on the system clipboard, start
  /// a 60 s timer. When it fires we re-read the pasteboard and clear
  /// it only if the value is still our secret — copying something
  /// else in the meantime is a strong "I'm done, don't touch it"
  /// signal that we must respect. 60 s matches 1Password's default
  /// and is enough to paste into a normal login flow but short enough
  /// that a forgotten clip doesn't sit in history for the next app.
  const scheduleSecretClear = useCallback(
    (expected: string) => {
      if (secretClearTimer.current !== null)
        window.clearTimeout(secretClearTimer.current);
      secretClearTimer.current = window.setTimeout(async () => {
        secretClearTimer.current = null;
        try {
          const { readText, writeText } = await import(
            '@tauri-apps/plugin-clipboard-manager'
          );
          const current = await readText().catch(() => null);
          if (current === expected) {
            await writeText('');
            toast({
              title: 'Secret cleared from clipboard',
              description: '60 s auto-clear to avoid leaving credentials behind.',
              variant: 'default',
              durationMs: 3000,
            });
          }
        } catch {
          /* best-effort — clipboard plugin can be unavailable in tests */
        }
      }, SECRET_CLEAR_MS);
    },
    [toast],
  );

  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

  // One-shot sweep on mount — in case the background startup prune
  // hasn't run yet (app relaunched, migration window) the popup still
  // shows a clean list on open. Fire-and-forget; the list reload is
  // driven by the `clipboard:changed` event the backend emits when
  // any rows are removed.
  useEffect(() => {
    pruneFiles().catch(() => {
      /* harmless — startup prune will have covered it */
    });
  }, []);

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
      rawItems.map((i) => {
        const type: ContentType =
          i.kind === 'image'
            ? 'image'
            : i.kind === 'file'
              ? 'file'
              : detectType(i.content);
        // Subtype runs for every text clip regardless of the top-level
        // ContentType — a JSON blob hits `code` via the brace in
        // CODE_HINTS but we still want the JSON subtype actions; a
        // secret that matches a URL would be wrong to expose as a
        // link anyway.
        const subtype: TextSubtype =
          i.kind === 'text' ? detectTextSubtype(i.content) : 'plain';
        return { ...i, type, subtype };
      }),
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
      const isSecret = item.kind === 'text' && item.subtype === 'secret';
      pasteItem(item.id)
        .then(() => {
          announce('Pasted');
          if (isSecret) scheduleSecretClear(item.content);
        })
        .catch((e) => console.error('paste failed:', e));
    },
    [flat, announce, scheduleSecretClear]
  );

  const copyAt = useCallback(
    (i: number) => {
      const item = flat[i];
      if (!item) return;
      const isSecret = item.kind === 'text' && item.subtype === 'secret';
      copyOnly(item.id)
        .then(() => {
          announce('Copied to clipboard');
          if (isSecret) {
            toast({
              title: 'Secret copied',
              description: 'Clipboard auto-clears in 60 s.',
              variant: 'default',
              durationMs: 3000,
            });
            scheduleSecretClear(item.content);
          } else {
            toast({ title: 'Copied', variant: 'success', durationMs: 2000 });
          }
          getCurrentWindow().hide().catch(() => {});
        })
        .catch((e) => {
          console.error('copy failed:', e);
          toast({ title: 'Copy failed', description: String(e), variant: 'error' });
        });
    },
    [flat, toast, announce, scheduleSecretClear]
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
      const isSecret = item.kind === 'text' && item.subtype === 'secret';
      bumpItemToTop(item.id);
      announce('Copied to clipboard');
      if (isSecret) {
        toast({
          title: 'Secret copied',
          description: 'Clipboard auto-clears in 60 s.',
          variant: 'default',
          durationMs: 3000,
        });
        scheduleSecretClear(item.content);
      } else {
        toast({ title: 'Copied', variant: 'success', durationMs: 1600 });
      }
      copyOnly(item.id).catch((e) => {
        console.error('copy failed:', e);
        toast({ title: 'Copy failed', description: String(e), variant: 'error' });
        reload();
      });
    },
    [flat, toast, announce, bumpItemToTop, reload, scheduleSecretClear],
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

  /// Pretty-print JSON clips in the preview dialog so a pasted API
  /// response reads like formatted source, not a flattened blob. For
  /// every other subtype the raw content is rendered untouched.
  const previewBody = useMemo(() => {
    if (!previewItem) return '';
    if (previewItem.kind !== 'text') return previewItem.content;
    if (detectTextSubtype(previewItem.content) === 'json') {
      return prettyJson(previewItem.content) ?? previewItem.content;
    }
    return previewItem.content;
  }, [previewItem]);

  const closePreview = useCallback(() => setPreviewId(null), []);

  const handlePreviewCopy = useCallback(async () => {
    if (!previewItem) return;
    if (await copyText(previewItem.content)) {
      toast({ title: 'Copied', variant: 'success', durationMs: 2000 });
    } else {
      toast({ title: 'Copy failed', variant: 'error' });
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

  /// Reveal a path in Finder. Route through the opener plugin — it
  /// already has the macOS entitlement and picks the right selector
  /// (`NSWorkspace -activateFileViewerSelectingURLs:`) for files +
  /// folders alike.
  const revealInFinder = useCallback(
    async (path: string) => {
      try {
        const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
        await revealItemInDir(path);
      } catch (e) {
        console.error('reveal failed:', e);
        toast({
          title: 'Could not reveal in Finder',
          description: String(e),
          variant: 'error',
        });
      }
    },
    [toast],
  );

  /// Open an arbitrary URL (`mailto:`, `tel:`, `http(s)://`, etc.)
  /// through the system handler. Used by the email/phone subtype
  /// actions — `openUrl` is the entitled path that keeps these links
  /// working when the popup is in a sandboxed webview.
  const openExternal = useCallback(
    async (url: string) => {
      try {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(url);
      } catch (e) {
        console.error('open url failed:', e);
        toast({ title: 'Could not open link', description: String(e), variant: 'error' });
      }
    },
    [toast],
  );

  /// Open a file with its default app (double-click equivalent).
  const openFile = useCallback(
    async (path: string) => {
      try {
        const { openPath } = await import('@tauri-apps/plugin-opener');
        await openPath(path);
      } catch (e) {
        console.error('open file failed:', e);
        toast({ title: 'Could not open file', description: String(e), variant: 'error' });
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

  const handleRowContextMenu = useCallback(
    (flatIndex: number, e: React.MouseEvent) => {
      const item = flat[flatIndex];
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      setIndex(flatIndex);
      setCtxMenu({ x: e.clientX, y: e.clientY, id: item.id });
    },
    // setIndex comes from useKeyboardNav — stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flat],
  );

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
      // Compute up-front: any shortcut that collides with native
      // textarea/input keystrokes (plain Enter, Shift+Enter, Backspace,
      // Space) MUST bail when focus lives in a composer — otherwise
      // typing a newline in Notes secretly copies the last-selected
      // clipboard row into the system clipboard.
      const target = e.target as HTMLElement | null;
      const typingInInput =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true;
      if (e.metaKey && ['1', '2', '3', '4', '5'].includes(e.key)) {
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
      if (e.shiftKey && e.key === 'Enter' && !typingInInput) {
        e.preventDefault();
        copyAt(index);
        return;
      }
      const item = flat[index];
      if (!item) return;
      if (e.metaKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        handleTogglePin(item.id);
      } else if (e.key === ' ' && !typingInInput && item.kind === 'text') {
        e.preventDefault();
        setPreviewId(item.id);
      } else if (e.key === ' ' && !typingInInput && item.kind === 'file') {
        e.preventDefault();
        setFilePreviewId(item.id);
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

  /// Build the context-menu action list for a given row. Pulls in
  /// subtype-aware entries (Copy pretty JSON, Copy hex as rgb, open
  /// mailto:, etc.) so power users can skip hovering for IconButtons.
  /// Every entry closes the menu after firing — the ContextMenu
  /// component handles that automatically via its `onSelect → onClose`
  /// wrapper, so individual handlers here focus on the side-effect.
  const buildCtxItems = useCallback(
    (item: (typeof typed)[number]): ContextMenuItem[] => {
      const out: ContextMenuItem[] = [];
      const idx = flat.findIndex((f) => f.id === item.id);
      out.push({
        kind: 'action',
        label: 'Paste',
        shortcut: '↵',
        icon: <ExternalIcon size={12} />,
        onSelect: () => {
          if (idx >= 0) pasteAt(idx);
        },
      });
      out.push({
        kind: 'action',
        label: 'Copy',
        shortcut: '⇧↵',
        icon: <CopyIcon size={12} />,
        onSelect: () => {
          if (idx >= 0) copyAt(idx);
        },
      });

      // kind-specific actions
      if (item.kind === 'file') {
        const files = parseFileMeta(item)?.files ?? [];
        const first = files[0];
        if (first) {
          out.push({ kind: 'separator' });
          out.push({
            kind: 'action',
            label: 'Reveal in Finder',
            icon: <FolderPathIcon />,
            onSelect: () => revealInFinder(first.path),
          });
          out.push({
            kind: 'action',
            label: 'Open with default app',
            icon: <ExternalIcon size={12} />,
            onSelect: () => openFile(first.path),
          });
          out.push({
            kind: 'action',
            label: 'Copy first file path',
            icon: <CopyIcon size={12} />,
            onSelect: () => {
              void copyText(first.path);
              toast({ title: 'Path copied', variant: 'success', durationMs: 1400 });
            },
          });
          if (files.length > 1) {
            out.push({
              kind: 'action',
              label: `Copy all ${files.length} paths`,
              icon: <CopyIcon size={12} />,
              onSelect: () => {
                void copyText(files.map((f) => f.path).join('\n'));
                toast({ title: 'Paths copied', variant: 'success', durationMs: 1400 });
              },
            });
          }
        }
      } else if (item.kind === 'image') {
        const meta = parseImageMeta(item);
        if (meta) {
          out.push({ kind: 'separator' });
          out.push({
            kind: 'action',
            label: 'Open in Preview',
            icon: <ExternalIcon size={12} />,
            onSelect: () => openImageInViewer(meta.path),
          });
          out.push({
            kind: 'action',
            label: 'Reveal PNG in Finder',
            icon: <FolderPathIcon />,
            onSelect: () => revealInFinder(meta.path),
          });
          out.push({
            kind: 'action',
            label: 'Copy PNG path',
            icon: <CopyIcon size={12} />,
            onSelect: () => {
              void copyText(meta.path);
              toast({ title: 'Path copied', variant: 'success', durationMs: 1400 });
            },
          });
        }
      } else if (item.kind === 'text') {
        if (item.subtype === 'json') {
          const pretty = prettyJson(item.content);
          if (pretty) {
            out.push({ kind: 'separator' });
            out.push({
              kind: 'action',
              label: 'Copy as pretty JSON',
              icon: <BraceIcon />,
              onSelect: () => {
                void copyText(pretty);
                toast({ title: 'Pretty JSON copied', variant: 'success', durationMs: 1400 });
              },
            });
          }
        }
        if (item.subtype === 'hex-color' || item.subtype === 'uuid') {
          out.push({ kind: 'separator' });
          out.push({
            kind: 'action',
            label:
              item.subtype === 'hex-color' ? 'Copy value' : 'Copy without dashes',
            icon: <HashIcon />,
            onSelect: () => {
              const value =
                item.subtype === 'uuid'
                  ? item.content.replace(/-/g, '')
                  : item.content.trim();
              void copyText(value);
              toast({ title: 'Copied', variant: 'success', durationMs: 1400 });
            },
          });
        }
        if (item.subtype === 'email') {
          out.push({ kind: 'separator' });
          out.push({
            kind: 'action',
            label: 'Send email',
            icon: <EmailIcon />,
            onSelect: () => openExternal(`mailto:${item.content.trim()}`),
          });
        }
        if (item.subtype === 'phone') {
          out.push({ kind: 'separator' });
          out.push({
            kind: 'action',
            label: 'Call / FaceTime',
            icon: <PhoneIcon />,
            onSelect: () =>
              openExternal(`tel:${item.content.replace(/[^+\d]/g, '')}`),
          });
        }
        if (item.subtype === 'file-path') {
          out.push({ kind: 'separator' });
          out.push({
            kind: 'action',
            label: 'Reveal in Finder',
            icon: <FolderPathIcon />,
            onSelect: () => revealInFinder(item.content.trim()),
          });
        }
        if (item.subtype === 'secret') {
          out.push({ kind: 'separator' });
          out.push({
            kind: 'action',
            label: revealedSecrets.has(item.id) ? 'Hide secret' : 'Reveal secret',
            icon: revealedSecrets.has(item.id) ? <LockIcon /> : <EyeIcon size={12} />,
            onSelect: () => toggleReveal(item.id),
          });
        }
        if (item.type === 'link' && item.subtype !== 'secret') {
          out.push({ kind: 'separator' });
          out.push({
            kind: 'action',
            label: 'Open in browser',
            icon: <ExternalIcon size={12} />,
            onSelect: () => openExternal(item.content.trim()),
          });
        }
        if (item.subtype !== 'secret' && isLongText(item.content)) {
          out.push({ kind: 'separator' });
          out.push({
            kind: 'action',
            label: 'Preview…',
            shortcut: 'Space',
            icon: <EyeIcon size={12} />,
            onSelect: () => setPreviewId(item.id),
          });
        }
      }

      // Tail: pin + delete always available.
      out.push({ kind: 'separator' });
      out.push({
        kind: 'action',
        label: item.pinned ? 'Unpin' : 'Pin',
        shortcut: '⌘P',
        icon: <PinIcon size={12} filled={item.pinned} />,
        onSelect: () => handleTogglePin(item.id),
      });
      out.push({
        kind: 'action',
        label: 'Delete',
        shortcut: '⌫',
        tone: 'danger',
        icon: <TrashIcon size={12} />,
        onSelect: () => handleDelete(item.id),
      });
      return out;
    },
    [
      flat,
      pasteAt,
      copyAt,
      revealInFinder,
      openFile,
      openImageInViewer,
      openExternal,
      toast,
      handleTogglePin,
      handleDelete,
      revealedSecrets,
      toggleReveal,
    ],
  );

  const renderRow = (item: (typeof typed)[number], flatIndex: number) => {
    const enterClass = item.id === newItemId ? 'clip-row-enter' : undefined;
    if (item.kind === 'file') {
      const fileMeta = parseFileMeta(item);
      const files = fileMeta?.files ?? [];
      if (files.length === 0) {
        // Malformed meta — render a compact "broken clip" row with
        // only a delete action, so the user can get it out of their
        // history without having to understand why.
        return (
          <Row
            key={item.id}
            primary="Unreadable file clip"
            icon={iconFor('file')}
            iconTint={typeTint.file.bg}
            iconColor={typeTint.file.fg}
            actions={
              <IconButton onClick={() => handleDelete(item.id)} title="Delete" tone="danger">
                <TrashIcon size={12} />
              </IconButton>
            }
            meta={
              <span className="t-tertiary text-meta font-mono">{iso(item.created_at)}</span>
            }
            pinned={item.pinned}
            active={index === flatIndex}
            selected={selectedIds.has(item.id)}
            onSelect={(e) => handleRowClick(flatIndex, e)}
            onContextMenu={(e) => handleRowContextMenu(flatIndex, e)}
            className={enterClass}
          />
        );
      }
      const first = files[0];
      const firstKind = detectFileKind({ name: first.name, mime: first.mime });
      const extraCount = files.length - 1;
      // Rendering strategy for the left-hand icon:
      //  - Single file image → 28 px thumbnail (matches `kind='image'`).
      //  - 2–4 images → tiny 2×2 collage so the user can see what's
      //    in the clip without opening the Space preview.
      //  - Anything else   → generic document icon.
      const imageFiles = files.filter((f) => {
        const k = detectFileKind({ name: f.name, mime: f.mime }).kind;
        return k === 'image';
      });
      const useCollage = files.length > 1 && imageFiles.length >= 2 && imageFiles.length <= 4;
      const icon = useCollage ? (
        <div className="w-7 h-7 rounded-md overflow-hidden grid grid-cols-2 grid-rows-2 gap-[1px] bg-white/10">
          {imageFiles.slice(0, 4).map((f) => (
            <img
              key={f.path}
              src={convertFileSrc(f.path)}
              alt=""
              className="w-full h-full object-cover"
              loading="lazy"
            />
          ))}
        </div>
      ) : firstKind.kind === 'image' ? (
        <img
          src={convertFileSrc(first.path)}
          alt=""
          className="w-7 h-7 rounded-md object-cover"
          loading="lazy"
        />
      ) : (
        iconFor('file')
      );
      const tint = typeTint.file;
      return (
        <Row
          key={item.id}
          primary={first.name}
          icon={icon}
          iconTint={firstKind.kind === 'image' || useCollage ? 'transparent' : tint.bg}
          iconColor={tint.fg}
          actions={
            <>
              <IconButton
                onClick={() => revealInFinder(first.path)}
                title="Reveal in Finder"
              >
                <EyeIcon size={12} />
              </IconButton>
              <IconButton
                onClick={() => openFile(first.path)}
                title="Open with default app"
              >
                <ExternalIcon size={12} />
              </IconButton>
              <IconButton
                onClick={() => handleTogglePin(item.id)}
                title={item.pinned ? 'Unpin' : 'Pin'}
              >
                <PinIcon size={12} filled={item.pinned} />
              </IconButton>
              <IconButton
                onClick={() => handleDelete(item.id)}
                title="Delete"
                tone="danger"
              >
                <TrashIcon size={12} />
              </IconButton>
            </>
          }
          meta={
            <>
              {extraCount > 0 && (
                <span
                  className="text-[10px] font-mono font-medium tabular-nums px-1.5 py-px rounded"
                  style={{ background: tint.bg, color: tint.fg }}
                  title={`${files.length} files copied together`}
                >
                  +{extraCount}
                </span>
              )}
              <span className="t-tertiary text-meta font-mono">
                {iso(item.created_at)}
              </span>
              {index === flatIndex && <Kbd>↵</Kbd>}
            </>
          }
          pinned={item.pinned}
          active={index === flatIndex}
          selected={selectedIds.has(item.id)}
          onSelect={(e) => handleRowClick(flatIndex, e)}
            onContextMenu={(e) => handleRowContextMenu(flatIndex, e)}
          className={enterClass}
        />
      );
    }
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
          onContextMenu={handleRowContextMenu}
          onSaveToNote={handleRowSaveToNote}
          className={enterClass}
        />
      );
    }
    const imageMeta = item.kind === 'image' ? parseImageMeta(item) : null;
    // Text rows now get subtype-driven visuals; image rows keep the
    // existing thumbnail path.
    const isSecret = item.subtype === 'secret';
    const showSecret = !isSecret || revealedSecrets.has(item.id);
    const subVisual = item.kind === 'text' ? subtypeVisual[item.subtype] : null;
    const tint = imageMeta
      ? typeTint.image
      : subVisual
        ? subVisual.tint
        : typeTint[item.type];
    const SubIcon = subVisual?.icon;
    // Hex/RGB clips swap the icon tint for the actual colour so the
    // user can recognise the shade at a glance.
    const hexSwatchColor =
      item.subtype === 'hex-color' && item.kind === 'text' ? item.content.trim() : null;
    const icon = imageMeta ? (
      <img
        src={convertFileSrc(imageMeta.path)}
        alt=""
        className="w-7 h-7 rounded-md object-cover"
      />
    ) : hexSwatchColor ? (
      <span
        className="w-7 h-7 rounded-md block border border-white/12"
        style={{ background: hexSwatchColor }}
        aria-hidden
      />
    ) : SubIcon ? (
      <SubIcon />
    ) : (
      iconFor(item.type)
    );
    const primary = imageMeta
      ? `Image · ${imageMeta.w}×${imageMeta.h}`
      : item.kind === 'text' && isSecret && !showSecret
        ? maskSecret(item.content)
        : item.kind === 'text' && item.subtype === 'json'
          ? item.content.replace(/\s+/g, ' ').slice(0, 160)
          : item.content;
    return (
      <Row
        key={item.id}
        primary={primary}
        icon={icon}
        iconTint={imageMeta || hexSwatchColor ? 'transparent' : tint.bg}
        iconColor={tint.fg}
        actions={
          <>
            {item.kind === 'text' && isSecret && (
              <IconButton
                onClick={() => toggleReveal(item.id)}
                title={showSecret ? 'Hide secret' : 'Reveal secret'}
              >
                <EyeIcon size={12} />
              </IconButton>
            )}
            {item.kind === 'text' && item.subtype === 'email' && (
              <IconButton
                onClick={() => openExternal(`mailto:${item.content.trim()}`)}
                title="Send email"
              >
                <ExternalIcon size={12} />
              </IconButton>
            )}
            {item.kind === 'text' && item.subtype === 'phone' && (
              <IconButton
                onClick={() =>
                  openExternal(`tel:${item.content.replace(/[^+\d]/g, '')}`)
                }
                title="Call / FaceTime"
              >
                <ExternalIcon size={12} />
              </IconButton>
            )}
            {item.kind === 'text' && item.subtype === 'file-path' && (
              <IconButton
                onClick={() => revealInFinder(item.content.trim())}
                title="Reveal in Finder"
              >
                <EyeIcon size={12} />
              </IconButton>
            )}
            {item.kind === 'text' && !isSecret && isLongText(item.content) && (
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
            {item.kind === 'text' && !isSecret && (
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
            onContextMenu={(e) => handleRowContextMenu(flatIndex, e)}
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
          style={{ background: accent(0.08) }}
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
        text={previewBody}
        onClose={closePreview}
        onCopy={handlePreviewCopy}
        onSaveToNote={handleSaveToNote}
      />
      {(() => {
        const ctxItem = ctxMenu ? typed.find((i) => i.id === ctxMenu.id) : null;
        if (!ctxMenu || !ctxItem) return null;
        return (
          <ContextMenu
            open
            x={ctxMenu.x}
            y={ctxMenu.y}
            items={buildCtxItems(ctxItem)}
            onClose={() => setCtxMenu(null)}
            label={`Actions for clipboard item ${ctxItem.id}`}
          />
        );
      })()}
      {(() => {
        const filePreviewItem =
          filePreviewId == null
            ? null
            : rawItems.find((i) => i.id === filePreviewId && i.kind === 'file') ?? null;
        const filePreviewFiles = filePreviewItem
          ? parseFileMeta(filePreviewItem)?.files ?? []
          : [];
        return (
          <FilePreviewDialog
            open={filePreviewItem !== null && filePreviewFiles.length > 0}
            files={filePreviewFiles}
            onClose={() => setFilePreviewId(null)}
            onRevealFirst={(p) => {
              void revealInFinder(p);
              setFilePreviewId(null);
            }}
            onOpenFirst={(p) => {
              void openFile(p);
              setFilePreviewId(null);
            }}
          />
        );
      })()}
    </div>
  );
};
