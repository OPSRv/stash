import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronIcon, SelectCheckIcon } from './Select.icons';

export type SelectOption<T extends string> = { value: T; label: string };

type SelectProps<T extends string> = {
  value: T;
  onChange: (next: T) => void;
  options: SelectOption<T>[];
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Where the popup opens. `auto` flips up when there isn't enough room below. */
  placement?: 'bottom' | 'top' | 'auto';
};

export const Select = <T extends string>({
  value,
  onChange,
  options,
  label,
  placeholder,
  disabled,
  placement = 'bottom',
}: SelectProps<T>) => {
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLUListElement | null>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [resolvedPlacement, setResolvedPlacement] = useState<'bottom' | 'top'>(
    placement === 'top' ? 'top' : 'bottom',
  );

  const selectedIndex = useMemo(
    () => Math.max(0, options.findIndex((o) => o.value === value)),
    [options, value]
  );
  const selected = options[selectedIndex];

  const openMenu = useCallback(() => {
    if (disabled) return;
    setHighlight(selectedIndex);
    setOpen(true);
  }, [disabled, selectedIndex]);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const commit = useCallback(
    (idx: number) => {
      const opt = options[idx];
      if (!opt) return;
      onChange(opt.value);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [options, onChange]
  );

  // Close when clicking outside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popupRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Resolve placement whenever the popup opens (auto = flip up if the popup
  // would otherwise overflow the viewport below the trigger).
  useLayoutEffect(() => {
    if (!open) return;
    if (placement !== 'auto') {
      setResolvedPlacement(placement);
      return;
    }
    const trigger = triggerRef.current;
    const popup = popupRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const popupHeight = popup?.offsetHeight ?? 0;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const fitsBelow = spaceBelow >= popupHeight + 8;
    setResolvedPlacement(fitsBelow || spaceBelow >= spaceAbove ? 'bottom' : 'top');
  }, [open, placement, options.length]);

  // Move focus to listbox when it opens (without scrolling ancestors), and
  // keep the highlighted option in view inside the popup only.
  useLayoutEffect(() => {
    if (!open) return;
    popupRef.current?.focus({ preventScroll: true });
  }, [open]);
  useLayoutEffect(() => {
    const ul = popupRef.current;
    if (!open || !ul) return;
    const li = ul.querySelector<HTMLLIElement>(`[data-idx="${highlight}"]`);
    if (!li) return;
    const top = li.offsetTop;
    const bottom = top + li.offsetHeight;
    if (top < ul.scrollTop) ul.scrollTop = top;
    else if (bottom > ul.scrollTop + ul.clientHeight) ul.scrollTop = bottom - ul.clientHeight;
  }, [open, highlight]);

  const onTriggerKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openMenu();
      return;
    }
  };

  const onListKey = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(options.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setHighlight(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setHighlight(options.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit(highlight);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKey}
        className="input-field rounded-md pl-2.5 pr-2 py-1 text-body inline-flex items-center gap-2 min-w-[120px] text-left disabled:opacity-50"
      >
        <span className="truncate flex-1">{selected?.label ?? placeholder ?? ''}</span>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <ul
          ref={popupRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          onKeyDown={onListKey}
          className={`select-popup absolute z-50 left-0 min-w-full max-h-60 overflow-y-auto nice-scroll rounded-md py-1 text-body outline-none ${
            resolvedPlacement === 'top' ? 'bottom-full mb-1' : 'mt-1'
          }`}
          style={{ minWidth: triggerRef.current?.offsetWidth }}
        >
          {options.map((o, idx) => {
            const isSelected = o.value === value;
            const isActive = idx === highlight;
            return (
              <li
                key={o.value || `__empty_${idx}`}
                role="option"
                aria-selected={isSelected}
                data-idx={idx}
                onMouseEnter={() => setHighlight(idx)}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep focus on list
                  commit(idx);
                }}
                className="px-2.5 py-1 cursor-pointer flex items-center gap-2"
                style={{
                  background: isActive ? 'rgba(255,255,255,0.08)' : 'transparent',
                }}
              >
                <span className="truncate flex-1">{o.label}</span>
                {isSelected && <SelectCheckIcon />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
