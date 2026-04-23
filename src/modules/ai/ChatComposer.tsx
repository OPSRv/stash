import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';

import { Button } from '../../shared/ui/Button';
import { Textarea } from '../../shared/ui/Textarea';
import type { VoicePhase } from '../../shared/hooks/useVoiceRecorder';

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
  /** Voice input: when any of the three are provided the composer
   *  renders a mic button next to Send. The hook + state live in the
   *  parent (`AiShell`) so the composer stays a dumb render. */
  voicePhase?: VoicePhase;
  voiceError?: string;
  onVoiceToggle?: () => void;
};

export const ChatComposer = ({
  value,
  onChange,
  onSend,
  onStop,
  isStreaming,
  disabled,
  placeholder,
  voicePhase,
  voiceError,
  onVoiceToggle,
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
  const voiceEnabled = !!onVoiceToggle;
  const voiceBusy = voicePhase === 'transcribing';
  const voiceRecording = voicePhase === 'recording';
  // When the recorder is busy the button is read-only — transcription
  // can't be cancelled mid-flight without losing the utterance. Other
  // phases (idle / error / recording) are all valid click targets.
  const voiceDisabled = !voiceEnabled || voiceBusy || disabled || isStreaming;

  return (
    <div
      className="flex items-end gap-2 px-3 py-2 border-t hair"
      style={{ background: 'var(--color-surface)' }}
    >
      <Textarea
        ref={textareaRef}
        value={value}
        disabled={disabled}
        placeholder={placeholder ?? 'Ask anything. Enter to send, Shift+Enter for newline.'}
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={handleKey}
        rows={MIN_ROWS}
        maxLength={16000}
        className="flex-1 resize-none nice-scroll"
        style={{
          lineHeight: `${LINE_HEIGHT}px`,
          minHeight: `${LINE_HEIGHT * MIN_ROWS + V_PADDING}px`,
          maxHeight: `${LINE_HEIGHT * MAX_ROWS + V_PADDING}px`,
        }}
        aria-label="Chat input"
      />
      {voiceEnabled ? (
        <Button
          aria-label={voiceRecording ? 'Stop recording' : 'Record voice'}
          aria-pressed={voiceRecording}
          title={
            voiceError
              ? voiceError
              : voiceRecording
              ? 'Stop (⌘⇧A)'
              : voiceBusy
              ? 'Transcribing…'
              : 'Record voice (⌘⇧A)'
          }
          onClick={onVoiceToggle}
          disabled={voiceDisabled}
          variant="soft"
          tone={voiceRecording ? 'danger' : voiceError ? 'danger' : 'accent'}
          shape="square"
          size="sm"
        >
          {voiceBusy ? (
            // Three-dot transcribing indicator — the stop glyph would
            // falsely suggest the action is cancellable.
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <circle cx="3" cy="7" r="1.2" fill="currentColor">
                <animate attributeName="opacity" values="0.3;1;0.3" dur="1s" repeatCount="indefinite" begin="0s" />
              </circle>
              <circle cx="7" cy="7" r="1.2" fill="currentColor">
                <animate attributeName="opacity" values="0.3;1;0.3" dur="1s" repeatCount="indefinite" begin="0.2s" />
              </circle>
              <circle cx="11" cy="7" r="1.2" fill="currentColor">
                <animate attributeName="opacity" values="0.3;1;0.3" dur="1s" repeatCount="indefinite" begin="0.4s" />
              </circle>
            </svg>
          ) : voiceRecording ? (
            // Filled square = recording in progress, press to stop. Matches
            // the Stop-stream button above for mental consistency.
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <rect x="3" y="3" width="8" height="8" rx="1" fill="currentColor" />
            </svg>
          ) : (
            // Classic microphone glyph.
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <rect x="5" y="1.5" width="4" height="7" rx="2" fill="currentColor" />
              <path
                d="M3 7a4 4 0 0 0 8 0"
                stroke="currentColor"
                strokeWidth="1.2"
                fill="none"
                strokeLinecap="round"
              />
              <path d="M7 11v1.5M5.5 12.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          )}
        </Button>
      ) : null}
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
