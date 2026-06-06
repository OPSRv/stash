import { useEffect, useRef, useState } from 'react';

export interface SelectOption {
  value: number;
  label: string;
}

interface Props {
  value: number;
  options: SelectOption[];
  onChange: (value: number) => void;
  disabled?: boolean;
  dataId?: string;
  placeholder?: string;
  className?: string;
}

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

/** Кастомний select: тригер + випадний список (з прокруткою, підсвіткою,
   скролом до вибраного, клавіатурою). Замінює нативний <select>. */
export const Select = ({
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
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedIndex = options.findIndex((o) => o.value === value);
  const current = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    setActive(selectedIndex < 0 ? 0 : selectedIndex);
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, selectedIndex]);

  // прокрутка до активного пункту
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
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit(active);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className={`relative ${className}`} ref={ref}>
      <button
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
      {open && (
        <div
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          className="scroll-area absolute z-40 mt-1 max-h-72 w-full min-w-max rounded-lg border border-ve-stroke bg-ve-bg-1 p-1 shadow-2xl"
        >
          {options.length === 0 && (
            <div className="px-3 py-2 text-sm text-ve-dim select-none">
              Немає пресетів
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
                className={`cursor-pointer truncate rounded-md px-3 py-1.5 text-sm transition ${
                  isSel
                    ? 'bg-ve-accent/15 text-ve-accent'
                    : isActive
                      ? 'bg-ve-bg-3 text-white'
                      : 'text-ve-text hover:bg-ve-bg-3'
                }`}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(i)}
              >
                {opt.label}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
