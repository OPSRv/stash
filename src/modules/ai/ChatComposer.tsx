import { useEffect, useRef, type KeyboardEvent } from 'react';

import { Button } from '../../shared/ui/Button';

type Props = {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  placeholder?: string;
};

export const ChatComposer = ({
  value,
  onChange,
  onSend,
  onStop,
  isStreaming,
  disabled,
  placeholder,
}: Props) => {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow up to 8 lines. Reset to auto first so shrinking works.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const max = 8 * 20; // ~8 rows at 20px line-height
    ta.style.height = `${Math.min(ta.scrollHeight, max)}px`;
  }, [value]);

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (isStreaming || disabled) return;
      if (!value.trim()) return;
      onSend();
    }
  };

  const canSend = !disabled && !isStreaming && value.trim().length > 0;

  return (
    <div
      className="flex items-end gap-2 px-3 py-2 border-t hair"
      style={{ background: 'var(--color-surface)' }}
    >
      <textarea
        ref={textareaRef}
        value={value}
        disabled={disabled || isStreaming}
        placeholder={placeholder ?? 'Ask anything. Enter to send, Shift+Enter for newline.'}
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={handleKey}
        rows={1}
        className="input-field flex-1 resize-none rounded-md px-3 py-2 text-body leading-[20px] max-h-[160px] overflow-y-auto nice-scroll"
        aria-label="Chat input"
      />
      {isStreaming ? (
        <Button
          aria-label="Stop"
          title="Stop (Esc)"
          onClick={onStop}
          variant="soft"
          tone="danger"
          shape="square"
          size="sm"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <rect x="3" y="3" width="8" height="8" rx="1" fill="currentColor" />
          </svg>
        </Button>
      ) : (
        <Button
          aria-label="Send"
          title="Send (Enter)"
          onClick={onSend}
          disabled={!canSend}
          variant="soft"
          tone="accent"
          shape="square"
          size="sm"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M2 7 L12 2 L9 7 L12 12 Z"
              fill="currentColor"
              stroke="currentColor"
              strokeLinejoin="round"
            />
          </svg>
        </Button>
      )}
    </div>
  );
};
