import type { ChangeEvent } from 'react';
import { Kbd } from './Kbd';

type SearchInputProps = {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  shortcutHint?: string;
  autoFocus?: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  compact?: boolean;
  /** Visual style. `underline` is the default top-of-column look (search at
   *  the head of a list, hairline below). `surface` is a self-contained
   *  rounded pill — use it when the search sits inside a sidebar header next
   *  to other controls and a flat hairline would look like a glued-on strip. */
  variant?: 'underline' | 'surface';
  trailing?: React.ReactNode;
  /** Show an inline clear (✕) button when the input has a non-empty value.
   *  Defaults to `true` for `surface`, `false` for `underline` (preserves
   *  existing layouts that compose their own trailing controls). */
  showClear?: boolean;
};

export const SearchInput = ({
  value,
  onChange,
  placeholder,
  shortcutHint,
  autoFocus,
  inputRef,
  compact,
  variant = 'underline',
  trailing,
  showClear,
}: SearchInputProps) => {
  const iconSize = compact ? 12 : 14;
  // Refresh-2026-04: surface variant tightens to 26 / 28 px, radius 6 px
  // (between --r-sm and --r-md), and gains a built-in clear (✕) when
  // `value` is non-empty. Default surface = `bg-hover`; focus lifts to
  // `bg-elev-flat` and the focus ring on the wrapper is the canonical
  // accent-soft halo, replacing the per-input ring-focus utility.
  const rowCls =
    variant === 'surface'
      ? compact
        ? 'search-surface flex items-center gap-1.5 h-[26px] px-2 rounded-[6px] [background:var(--bg-hover)] focus-within:[background:var(--bg-elev)] focus-within:[box-shadow:0_0_0_0.5px_rgb(var(--stash-accent-rgb)),0_0_0_3px_var(--accent-soft)] transition-[background,box-shadow] duration-150'
        : 'search-surface flex items-center gap-2 h-[28px] px-2.5 rounded-[6px] [background:var(--bg-hover)] focus-within:[background:var(--bg-elev)] focus-within:[box-shadow:0_0_0_0.5px_rgb(var(--stash-accent-rgb)),0_0_0_3px_var(--accent-soft)] transition-[background,box-shadow] duration-150'
      : compact
        ? 'flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 border-b hair'
        : 'flex items-center gap-2.5 px-3 py-2.5 border-b hair';
  const showClearResolved = showClear ?? variant === 'surface';
  const inputCls =
    variant === 'surface'
      ? 'flex-1 min-w-0 bg-transparent outline-none text-[12px] t-primary placeholder:t-tertiary'
      : 'flex-1 min-w-0 bg-transparent outline-none text-body t-primary placeholder:t-tertiary';
  return (
    <div className={rowCls}>
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="t-tertiary shrink-0"
        aria-hidden
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        ref={inputRef}
        type="search"
        role="searchbox"
        value={value}
        autoFocus={autoFocus}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        className={inputCls}
      />
      {showClearResolved && value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange('')}
          className="search-clear shrink-0 w-[18px] h-[18px] rounded-[4px] inline-flex items-center justify-center t-tertiary hover:t-primary hover:[background:var(--bg-hover)] transition-colors"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      )}
      {shortcutHint && <Kbd>{shortcutHint}</Kbd>}
      {trailing}
    </div>
  );
};
