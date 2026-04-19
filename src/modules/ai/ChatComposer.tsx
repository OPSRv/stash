import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';

import { Button } from '../../shared/ui/Button';

const LINE_HEIGHT = 20;
const MIN_ROWS = 1;
const MAX_ROWS = 6;
const V_PADDING = 16; // py-2 → 8 + 8

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

  // Auto-grow up to MAX_ROWS, then internal scrolling kicks in. Reset to
  // auto first so shrinking works on backspace.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const max = LINE_HEIGHT * MAX_ROWS + V_PADDING;
    const scrollH = ta.scrollHeight;
    ta.style.height = `${Math.min(scrollH, max)}px`;
    // Only show the scrollbar once content actually needs one — otherwise a
    // single empty line renders with a permanent scroll strip on the right.
    ta.style.overflowY = scrollH > max ? 'auto' : 'hidden';
  }, [value]);

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Swallow plain typing keys so window-level listeners registered by
    // other tabs (ClipboardPopup treats Space/Backspace/Enter as commands
    // whenever the event target isn't an <input>) don't run on keystrokes
    // meant for the chat textarea. Modifier combos (⌘K, ⌘/, ⌘⇧F, ⌘⌥<N>)
    // still propagate so the popup's global shortcuts keep working.
    if (!e.metaKey && !e.ctrlKey && !e.altKey) {
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
    }
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
        disabled={disabled}
        placeholder={placeholder ?? 'Ask anything. Enter to send, Shift+Enter for newline.'}
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={handleKey}
        rows={MIN_ROWS}
        className="input-field flex-1 resize-none rounded-md px-3 py-2 text-body nice-scroll"
        style={{
          lineHeight: `${LINE_HEIGHT}px`,
          minHeight: `${LINE_HEIGHT * MIN_ROWS + V_PADDING}px`,
          maxHeight: `${LINE_HEIGHT * MAX_ROWS + V_PADDING}px`,
        }}
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
              d="M2 2 L12 7 L2 12 L5 7 Z"
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
