import type { ChangeEvent } from 'react';
import { Kbd } from './Kbd';

type SearchInputProps = {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  shortcutHint?: string;
  autoFocus?: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
};

export const SearchInput = ({
  value,
  onChange,
  placeholder,
  shortcutHint,
  autoFocus,
  inputRef,
}: SearchInputProps) => (
  <div className="flex items-center gap-2.5 px-3 py-2.5 border-b hair">
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="t-tertiary"
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
      className="flex-1 bg-transparent outline-none text-body t-primary"
    />
    {shortcutHint && <Kbd>{shortcutHint}</Kbd>}
  </div>
);
