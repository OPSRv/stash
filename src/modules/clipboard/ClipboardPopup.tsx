import { useEffect, useMemo, useState } from 'react';
import { Kbd } from '../../shared/ui/Kbd';
import { Row } from '../../shared/ui/Row';
import { SearchInput } from '../../shared/ui/SearchInput';
import { SectionLabel } from '../../shared/ui/SectionLabel';
import { useKeyboardNav } from '../../shared/hooks/useKeyboardNav';
import type { ClipboardItem } from './api';
import { listItems, searchItems } from './api';

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

  useEffect(() => {
    let cancelled = false;
    const load = query.trim() ? searchItems(query) : listItems();
    load.then((data) => {
      if (!cancelled) setItems(data);
    });
    return () => {
      cancelled = true;
    };
  }, [query]);

  const { pinned, recent } = useMemo(() => {
    return {
      pinned: items.filter((i) => i.pinned),
      recent: items.filter((i) => !i.pinned),
    };
  }, [items]);

  const flat = useMemo(() => [...pinned, ...recent], [pinned, recent]);

  const { index, setIndex } = useKeyboardNav({ itemCount: flat.length });

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

  return (
    <div className="flex flex-col h-full">
      <SearchInput value={query} onChange={setQuery} placeholder="Search clipboard" shortcutHint="⌘K" />
      <div className="flex-1 overflow-y-auto nice-scroll" role="listbox">
        {pinned.length > 0 && (
          <>
            <div className="px-3 pt-3 pb-1">
              <SectionLabel>Pinned</SectionLabel>
            </div>
            {pinned.map((item, i) => (
              <Row
                key={item.id}
                primary={item.content}
                meta={
                  <>
                    <span className="t-tertiary text-meta font-mono">{iso(item.created_at)}</span>
                    {index === i && <Kbd>↵</Kbd>}
                  </>
                }
                pinned
                active={index === i}
                onSelect={() => setIndex(i)}
              />
            ))}
          </>
        )}
        {recent.length > 0 && (
          <>
            <div className="px-3 pt-3 pb-1">
              <SectionLabel>Recent</SectionLabel>
            </div>
            {recent.map((item, i) => {
              const flatIndex = pinned.length + i;
              return (
                <Row
                  key={item.id}
                  primary={item.content}
                  meta={
                    <>
                      <span className="t-tertiary text-meta font-mono">{iso(item.created_at)}</span>
                      {index === flatIndex && <Kbd>↵</Kbd>}
                    </>
                  }
                  active={index === flatIndex}
                  onSelect={() => setIndex(flatIndex)}
                />
              );
            })}
          </>
        )}
        {flat.length === 0 && query && (
          <div className="p-4 t-tertiary text-meta text-center">No clipboard items match.</div>
        )}
      </div>
    </div>
  );
};
