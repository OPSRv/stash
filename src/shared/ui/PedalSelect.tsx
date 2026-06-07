import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface PedalSelectOption {
  value: number;
  label: string;
}

interface Props {
  value: number;
  options: PedalSelectOption[];
  onChange: (value: number) => void;
  disabled?: boolean;
  dataId?: string;
  placeholder?: string;
  className?: string;
}

type Coords = {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
};

const Chevron = ({ open }: { open: boolean }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    className={`shrink-0 text-ve-dim transition-transform ${open ? 'rotate-180' : ''}`}
    aria-hidden="true"
  >
    <path
      d="M4 6l4 4 4-4"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const Check = () => (
  <svg width="13" height="13" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="shrink-0">
    <path
      d="M2.5 6.5l2.5 2.5 4.5-5"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const MARGIN = 8; // viewport gap kept above/below the popup
const MAX_POPUP = 288; // matches the old max-h-72 cap

/** Dark "device-chrome" select: trigger + dropdown list (scroll, highlight,
 * scroll-into-view, keyboard). Replaces the native <select> on the fixed dark
 * `ve-` palette shared by the Valeton editor and the pedal-style modules
 * (Tuner / Metronome) in every theme — for the theme-aware app select see
 * `shared/ui/Select`.
 *
 * The popup is rendered through a portal with `position: fixed`, anchored to
 * the trigger, so it escapes any `overflow: hidden` / `isolation` ancestor
 * (e.g. the `.pedal-enclosure` casing) instead of being clipped. It flips above
 * the trigger when there isn't enough room below. Options are addressed by a
 * numeric `value` (index-friendly). */
export const PedalSelect = ({
  value,
  options,
  onChange,
  disabled,
  dataId,
  placeholder = '—',
  className = '',
}: Props) => {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [coords, setCoords] = useState<Coords | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedIndex = options.findIndex((o) => o.value === value);
  const current = options[selectedIndex];

  // Position the popup (fixed) relative to the trigger, flipping above it when
  // the natural list height won't fit below. Runs before paint, so there's no
  // flash at the wrong spot.
  const place = useCallback(() => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom - MARGIN;
    const above = rect.top - MARGIN;
    const contentH = listRef.current?.scrollHeight ?? 0;
    const desired = Math.min(contentH, MAX_POPUP);
    const dropUp = below < desired && above > below;
    setCoords({
      left: rect.left,
      width: rect.width,
      top: dropUp ? undefined : rect.bottom + 4,
      bottom: dropUp ? window.innerHeight - rect.top + 4 : undefined,
      maxHeight: Math.max(120, Math.min(MAX_POPUP, dropUp ? above : below)),
    });
  }, []);

  useEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    setActive(selectedIndex < 0 ? 0 : selectedIndex);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, selectedIndex]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, options.length, place]);

  // Keep the popup pinned to the trigger while the surrounding area scrolls or
  // the window resizes.
  useEffect(() => {
    if (!open) return;
    const onMove = () => place();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, place]);

  // Scroll the active option into view inside the popup only.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const commit = (i: number) => {
    const opt = options[i];
    if (opt) onChange(opt.value);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(options.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit(active);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className={`relative ${className}`}>
      <button
        ref={btnRef}
        type="button"
        data-id={dataId}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-ve-stroke bg-ve-bg-2 px-3 py-2 text-left text-sm text-ve-text transition hover:border-[#3a434f] focus-visible:border-ve-accent focus-visible:ring-2 focus-visible:ring-ve-accent/40 focus-visible:outline-none disabled:opacity-40"
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onKeyDown}
      >
        <span className="truncate">
          {current ? current.label : placeholder}
        </span>
        <Chevron open={open} />
      </button>
      {open &&
        createPortal(
          <div
            ref={listRef}
            role="listbox"
            tabIndex={-1}
            className="scroll-area fixed min-w-max rounded-lg border border-ve-stroke bg-ve-bg-1 p-1 shadow-2xl"
            style={{
              left: coords?.left,
              top: coords?.top,
              bottom: coords?.bottom,
              width: coords?.width,
              maxHeight: coords?.maxHeight,
              overflowY: 'auto',
              zIndex: 1050,
              visibility: coords ? 'visible' : 'hidden',
            }}
          >
            {options.length === 0 && (
              <div className="px-3 py-2 text-sm text-ve-dim select-none">
                No options
              </div>
            )}
            {options.map((opt, i) => {
              const isSel = opt.value === value;
              const isActive = i === active;
              return (
                <div
                  key={opt.value}
                  role="option"
                  tabIndex={-1}
                  aria-selected={isSel}
                  className={`flex cursor-pointer items-center justify-between gap-2 rounded-md px-3 py-1.5 text-sm transition ${
                    isSel
                      ? 'bg-ve-accent/15 text-ve-accent'
                      : isActive
                        ? 'bg-ve-bg-3 text-white'
                        : 'text-ve-text hover:bg-ve-bg-3'
                  }`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => commit(i)}
                >
                  <span className="truncate">{opt.label}</span>
                  {isSel && <Check />}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
};