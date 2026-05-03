import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { accent } from '../theme/accent';
import { useFocusTrap } from './useFocusTrap';

type SearchHit = {
  kind: 'clipboard' | 'download' | 'note';
  id: number;
  title: string;
  snippet: string;
  ts: number;
};

const kindBadge: Record<SearchHit['kind'], { label: string; bg: string }> = {
  clipboard: { label: 'CLIP', bg: accent(0.18) },
  download: { label: 'DL', bg: 'rgba(34,197,94,0.18)' },
  note: { label: 'NOTE', bg: 'rgba(236,72,153,0.18)' },
};

const kindToTab: Record<SearchHit['kind'], string> = {
  clipboard: 'clipboard',
  download: 'downloads',
  note: 'notes',
};

export const GlobalSearch = ({
  open,
  onClose,
  onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (tab: string) => void;
}) => {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(panelRef, open, { initialFocus: inputRef });

  const runSearch = useCallback((query: string) => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    invoke<SearchHit[]>('global_search', { query })
      .then((data) => {
        setHits(data);
        setActive(0);
      })
      .catch(() => setHits([]));
  }, []);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setHits([]);
    setActive(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 10);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => runSearch(q), 120);
    return () => window.clearTimeout(t);
  }, [q, open, runSearch]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Capture-phase + stopImmediatePropagation so PopupShell's
        // window Esc handler doesn't hide the whole popup behind the
        // search overlay. Same fix as `Modal`/`Lightbox`.
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => Math.min(hits.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter' && hits[active]) {
        e.preventDefault();
        onNavigate(kindToTab[hits[active].kind]);
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, hits, active, onClose, onNavigate]);

  if (!open) return null;

  return (
    <div
      className="absolute inset-0 z-[60] flex items-start justify-center pt-10 px-6"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(8px)' }}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Global search"
        className="rounded-xl w-full max-w-[560px] overflow-hidden"
        style={{
          background: 'rgba(30,30,30,0.96)',
          border: '1px solid rgba(255,255,255,0.04)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          placeholder="Search clipboard, downloads, notes…"
          className="w-full px-4 py-3 bg-transparent outline-none t-primary text-heading"
        />
        <div className="max-h-[360px] overflow-y-auto nice-scroll border-t hair">
          {hits.length === 0 && q && (
            <div className="p-4 t-tertiary text-meta text-center">No results.</div>
          )}
          {hits.map((h, i) => {
            const b = kindBadge[h.kind];
            return (
              <button
                key={`${h.kind}-${h.id}`}
                onClick={() => {
                  onNavigate(kindToTab[h.kind]);
                  onClose();
                }}
                onMouseEnter={() => setActive(i)}
                className={`w-full text-left px-3 py-2 flex items-center gap-3 ${
                  i === active ? 'row-active' : ''
                }`}
              >
                <span
                  className="px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wider shrink-0 t-primary"
                  style={{ background: b.bg }}
                >
                  {b.label}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="t-primary text-body truncate block">
                    {h.title || 'Untitled'}
                  </span>
                  <span className="t-tertiary text-meta truncate block">
                    {h.snippet}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
