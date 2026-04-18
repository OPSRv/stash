import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Kbd } from '../../shared/ui/Kbd';
import { IconButton } from '../../shared/ui/IconButton';
import { Row } from '../../shared/ui/Row';
import { SearchInput } from '../../shared/ui/SearchInput';
import { SectionLabel } from '../../shared/ui/SectionLabel';
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

const PinIcon = ({ filled }: { filled: boolean }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 3.5 13 6v5l-4 3v2h5v5l1 1 1-1v-5h5v-2l-4-3V6l-3-2.5z" />
  </svg>
);

const TrashIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6" />
  </svg>
);

export const ClipboardPopup = () => {
  const [rawItems, setRawItems] = useState<ClipboardItem[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [reloadNonce, setReloadNonce] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    const load = query.trim() ? searchItems(query) : listItems();
    load.then((data) => {
      if (!cancelled) setRawItems(data);
    });
    return () => {
      cancelled = true;
    };
  }, [query, reloadNonce]);

  useEffect(() => {
    const unlisten = listen('clipboard:changed', reload);
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [reload]);

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
      if (item) pasteItem(item.id).catch((e) => console.error('paste failed:', e));
    },
    [flat]
  );

  const copyAt = useCallback(
    (i: number) => {
      const item = flat[i];
      if (!item) return;
      copyOnly(item.id)
        .then(() => getCurrentWindow().hide().catch(() => {}))
        .catch((e) => console.error('copy failed:', e));
    },
    [flat]
  );

  const onSelect = useCallback(
    (i: number) => pasteAt(i),
    [pasteAt]
  );

  const { index, setIndex } = useKeyboardNav({
    itemCount: flat.length,
    onSelect,
  });

  const handleTogglePin = useCallback(
    (id: number) => {
      togglePin(id).then(reload).catch((e) => console.error('togglePin failed:', e));
    },
    [reload]
  );

  const handleDelete = useCallback(
    (id: number) => {
      deleteItem(id).then(reload).catch((e) => console.error('delete failed:', e));
    },
    [reload]
  );

  const handleClearAll = useCallback(() => {
    clearAll().then(reload).catch((e) => console.error('clearAll failed:', e));
  }, [reload]);

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
      if (e.key === 'Escape' && query) {
        e.preventDefault();
        setQuery('');
        return;
      }
      if (e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        copyAt(index);
        return;
      }
      const item = flat[index];
      if (!item) return;
      if (e.metaKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        handleTogglePin(item.id);
      } else if (e.key === 'Backspace' && (e.target as HTMLElement | null)?.tagName !== 'INPUT') {
        e.preventDefault();
        handleDelete(item.id);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [flat, index, query, copyAt, handleTogglePin, handleDelete]);

  const totalBytes = useMemo(
    () => typed.reduce((sum, i) => sum + i.content.length, 0),
    [typed]
  );
  const formatBytes = (n: number) =>
    n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

  const renderRow = (item: (typeof typed)[number], flatIndex: number) => {
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
            <IconButton onClick={() => handleTogglePin(item.id)} title={item.pinned ? 'Unpin' : 'Pin'}>
              <PinIcon filled={item.pinned} />
            </IconButton>
            <IconButton onClick={() => handleDelete(item.id)} title="Delete" tone="danger">
              <TrashIcon />
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
        onSelect={() => {
          setIndex(flatIndex);
          pasteAt(flatIndex);
        }}
      />
    );
  };

  const isEmpty = flat.length === 0;

  return (
    <div className="flex flex-col h-full">
      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder="Search clipboard"
        shortcutHint="⌘K"
        inputRef={searchRef}
      />

      <div className="flex-1 overflow-y-auto nice-scroll" role="listbox">
        {isEmpty && !query && (
          <div className="h-full flex items-center justify-center t-tertiary text-meta">
            No clipboard items yet — copy something.
          </div>
        )}
        {isEmpty && query && (
          <div className="p-4 t-tertiary text-meta text-center">No clipboard items match.</div>
        )}

        {pinned.length > 0 && (
          <>
            <div className="px-3 pt-3 pb-1">
              <SectionLabel>Pinned</SectionLabel>
            </div>
            {pinned.map((item, i) => renderRow(item, i))}
          </>
        )}
        {recent.length > 0 && (
          <>
            <div className="px-3 pt-3 pb-1">
              <SectionLabel>Recent</SectionLabel>
            </div>
            {recent.map((item, i) => renderRow(item, pinned.length + i))}
          </>
        )}
      </div>

      <footer
        className="flex items-center justify-between px-3 py-2 border-t hair"
        style={{ background: 'rgba(0,0,0,0.18)' }}
      >
        <div className="flex items-center gap-1">
          {filters.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`px-2 py-1 rounded-md flex items-center gap-1.5 text-meta font-medium ${
                filter === f.id ? 't-primary' : 't-secondary'
              }`}
              style={filter === f.id ? { background: 'rgba(255,255,255,0.06)' } : undefined}
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
          <button
            onClick={handleClearAll}
            className="t-secondary hover:text-red-400 text-meta px-2 py-1 rounded"
            style={{ background: 'rgba(255,255,255,0.04)' }}
            title="Clear all unpinned items"
          >
            Clear
          </button>
        </div>
      </footer>
    </div>
  );
};
