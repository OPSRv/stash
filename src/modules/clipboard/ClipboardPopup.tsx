import { useCallback, useEffect, useMemo, useState } from 'react';
import { Kbd } from '../../shared/ui/Kbd';
import { Row } from '../../shared/ui/Row';
import { SearchInput } from '../../shared/ui/SearchInput';
import { SectionLabel } from '../../shared/ui/SectionLabel';
import { useKeyboardNav } from '../../shared/hooks/useKeyboardNav';
import type { ClipboardItem } from './api';
import { deleteItem, listItems, pasteItem, searchItems, togglePin } from './api';

const iso = (ts: number) => {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
};

export const ClipboardPopup = () => {
  const [items, setItems] = useState<ClipboardItem[]>([]);
  const [query, setQuery] = useState('');
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = query.trim() ? searchItems(query) : listItems();
    load.then((data) => {
      if (!cancelled) setItems(data);
    });
    return () => {
      cancelled = true;
    };
  }, [query, reloadNonce]);

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
      if (item) pasteItem(item.id);
    },
    [flat]
  );

  const { index, setIndex } = useKeyboardNav({
    itemCount: flat.length,
    onSelect: onPaste,
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const item = flat[index];
      if (!item) return;
      if (e.metaKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        togglePin(item.id).then(() => setReloadNonce((n) => n + 1));
      } else if (e.key === 'Backspace' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        deleteItem(item.id).then(() => setReloadNonce((n) => n + 1));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [flat, index]);

  if (flat.length === 0 && !query) {
    return (
      <div className="flex flex-col h-full">
        <SearchInput value={query} onChange={setQuery} placeholder="Search clipboard" shortcutHint="⌘K" />
        <div className="flex-1 flex items-center justify-center t-tertiary text-meta">
          No clipboard items yet — copy something.
        </div>
      </div>
    );
  }

  const renderRow = (item: ClipboardItem, flatIndex: number) => (
    <Row
      key={item.id}
      primary={item.content}
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

  return (
    <div className="flex flex-col h-full">
      <SearchInput value={query} onChange={setQuery} placeholder="Search clipboard" shortcutHint="⌘K" />
      <div className="flex-1 overflow-y-auto nice-scroll" role="listbox">
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
        {flat.length === 0 && query && (
          <div className="p-4 t-tertiary text-meta text-center">No clipboard items match.</div>
        )}
      </div>
    </div>
  );
};
