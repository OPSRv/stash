import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Kbd } from '../../shared/ui/Kbd';
import { Row } from '../../shared/ui/Row';
import { SearchInput } from '../../shared/ui/SearchInput';
import { SectionLabel } from '../../shared/ui/SectionLabel';
import { useKeyboardNav } from '../../shared/hooks/useKeyboardNav';
import { convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ClipboardItem } from './api';
import { deleteItem, listItems, parseImageMeta, pasteItem, searchItems, togglePin } from './api';
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

export const ClipboardPopup = () => {
  const [rawItems, setRawItems] = useState<ClipboardItem[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [reloadNonce, setReloadNonce] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);

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
    const unlisten = listen('clipboard:changed', () => setReloadNonce((n) => n + 1));
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

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

  const onPaste = useCallback(
    (i: number) => {
      const item = flat[i];
      if (item) pasteItem(item.id).catch((e) => console.error('paste failed:', e));
    },
    [flat]
  );

  const { index, setIndex } = useKeyboardNav({
    itemCount: flat.length,
    onSelect: onPaste,
  });

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
      const item = flat[index];
      if (!item) return;
      if (e.metaKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        togglePin(item.id)
          .then(() => setReloadNonce((n) => n + 1))
          .catch((err) => console.error('togglePin failed:', err));
      } else if (e.key === 'Backspace' && (e.target as HTMLElement | null)?.tagName !== 'INPUT') {
        e.preventDefault();
        deleteItem(item.id)
          .then(() => setReloadNonce((n) => n + 1))
          .catch((err) => console.error('deleteItem failed:', err));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [flat, index]);

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
    const primary = imageMeta
      ? `Image · ${imageMeta.w}×${imageMeta.h}`
      : item.content;
    return (
      <Row
        key={item.id}
        primary={primary}
        icon={icon}
        iconTint={imageMeta ? 'transparent' : tint.bg}
        iconColor={tint.fg}
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
          onPaste(flatIndex);
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
            <div className="px-3 pt-3 pb-1 flex items-center gap-2">
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
        <span className="t-tertiary text-meta">
          {typed.length} items · {formatBytes(totalBytes)}
        </span>
      </footer>
    </div>
  );
};
