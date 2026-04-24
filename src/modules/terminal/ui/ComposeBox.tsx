import { forwardRef, useRef, useState } from 'react';

import { Button } from '../../../shared/ui/Button';
import {
  CloseIcon,
  MicIcon,
  SendToAiIcon,
  StopCircleIcon,
  TrashIcon,
} from '../../../shared/ui/icons';
import type { UseVoiceRecorder } from '../../../shared/hooks/useVoiceRecorder';

export type ComposeBoxProps = {
  value: string;
  onChange: (next: string) => void;
  /// `submit=true` => send + clear (Enter / Send button).
  /// `submit=false` => insert without clearing (Insert button).
  onSend: (submit: boolean) => void | Promise<void>;
  /// Called once for each file pasted or dropped. Consumer decides
  /// whether to persist, insert a path reference, etc.
  onFileAttach: (file: File) => void | Promise<void>;
  /// Focus terminal when the user escapes out of compose.
  onEscape: () => void;
  /// Dismiss the Compose strip entirely — wired to the header close
  /// button and Esc. When omitted the close affordance is hidden and
  /// Esc falls back to `onEscape` (legacy focus-only behaviour).
  onClose?: () => void;
  /// Whisper recorder state + toggle. The hook lives in the shell so
  /// transcripts can also land in `value` via the `insertAtCursor`
  /// helper; here we only render its UI.
  voice: UseVoiceRecorder;
  /// Narrow-mode flag — hides the hint and collapses Record/Send to
  /// icon-only buttons.
  compact: boolean;
};

/// Compose strip docked at the bottom of a pane. Opaque elevated
/// surface (so terminal scrollback never bleeds through), recessed
/// textarea, Send / Insert / Clear action group, Whisper record
/// button, and file paste/drop support.
///
/// The outer div is itself a file dropzone — dragging a PDF from
/// Finder over any part of the compose strip lights up an accent
/// border on the textarea.
const MIN_COMPOSE_HEIGHT = 96;
const MAX_COMPOSE_HEIGHT = 460;
const DEFAULT_COMPOSE_HEIGHT = 120;

export const ComposeBox = forwardRef<HTMLTextAreaElement, ComposeBoxProps>(
  function ComposeBox(
    { value, onChange, onSend, onFileAttach, onEscape, onClose, voice },
    ref,
  ) {
    const [dragOver, setDragOver] = useState(false);
    /// Textarea height in px. Drag the top-edge grip to grow Compose
    /// upward into the terminal area; the pane re-fits xterm on the
    /// next frame so the shell always occupies the remaining space.
    const [textareaHeight, setTextareaHeight] = useState<number>(
      DEFAULT_COMPOSE_HEIGHT,
    );
    const resizeStartY = useRef(0);
    const resizeStartH = useRef(0);
    const onResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      resizeStartY.current = e.clientY;
      resizeStartH.current = textareaHeight;
      const move = (ev: PointerEvent) => {
        // Dragging UP => smaller clientY => larger compose.
        const delta = resizeStartY.current - ev.clientY;
        const next = Math.max(
          MIN_COMPOSE_HEIGHT,
          Math.min(MAX_COMPOSE_HEIGHT, resizeStartH.current + delta),
        );
        setTextareaHeight(next);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
    const handleFiles = async (files: File[]) => {
      // Sequential so caret placement stays predictable when the
      // consumer inserts an `@path` per file.
      for (const f of files) await onFileAttach(f);
    };

    return (
      <div
        className="border-t hair flex flex-col gap-1.5 px-3 py-2 shrink-0 relative"
        style={{
          // Semi-transparent pane colour + backdrop-blur — the strip
          // reads as frosted-glass chrome over the tinted terminal
          // backdrop instead of a flat grey slab, while still being
          // opaque enough that xterm scrollback can't bleed through.
          background: 'rgba(16, 18, 22, 0.6)',
          backdropFilter: 'blur(18px) saturate(1.4)',
          WebkitBackdropFilter: 'blur(18px) saturate(1.4)',
        }}
        onDragEnter={(e) => {
          if (Array.from(e.dataTransfer.types).indexOf('Files') >= 0) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.types).indexOf('Files') >= 0) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            if (!dragOver) setDragOver(true);
          }
        }}
        onDragLeave={(e) => {
          // Only clear when the pointer exits the wrapper entirely —
          // moving between the header row and the textarea would
          // otherwise flicker the border.
          const next = e.relatedTarget as Node | null;
          if (!next || !e.currentTarget.contains(next)) setDragOver(false);
        }}
        onDrop={(e) => {
          setDragOver(false);
          const files = Array.from(e.dataTransfer?.files ?? []);
          if (files.length === 0) return;
          e.preventDefault();
          void handleFiles(files);
        }}
        data-testid="terminal-compose"
      >
        {/* Top-edge drag grip — a full-width 6 px band whose centre line
            pulses faintly on hover so users discover they can grow
            Compose upward into the terminal area. */}
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize compose height"
          onPointerDown={onResizeStart}
          className="absolute left-0 right-0 group"
          style={{
            top: -3,
            height: 6,
            cursor: 'ns-resize',
            touchAction: 'none',
            zIndex: 2,
          }}
          data-testid="terminal-compose-resize"
        >
          <div
            className="mx-auto transition-colors"
            style={{
              marginTop: 2,
              width: 36,
              height: 2,
              borderRadius: 2,
              background: 'rgba(255,255,255,0.12)',
            }}
          />
        </div>
        <div className="flex items-center gap-2 min-w-0">
          <span className="t-tertiary text-meta shrink-0 select-none">
            Compose
          </span>
          {voice.phase === 'recording' && (
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: 'var(--color-danger-fg, #ef4444)',
              }}
            />
          )}
          {voice.phase === 'error' && voice.error && (
            <span
              className="t-tertiary text-meta"
              title={voice.error}
              style={{ color: 'var(--color-warning-fg)' }}
            >
              ⚠ mic
            </span>
          )}
          <div className="flex-1" />
          <div className="flex items-center gap-0.5 shrink-0">
            <Button
              size="xs"
              variant={voice.phase === 'recording' ? 'soft' : 'ghost'}
              tone={voice.phase === 'recording' ? 'danger' : 'neutral'}
              disabled={voice.busy}
              onClick={() => voice.toggle()}
              title={
                voice.phase === 'recording'
                  ? 'Stop recording and transcribe'
                  : voice.busy
                    ? 'Transcribing…'
                    : 'Record voice, transcribe to text (Whisper)'
              }
              aria-label={
                voice.phase === 'recording' ? 'Stop recording' : 'Record voice'
              }
            >
              {voice.phase === 'recording' ? (
                <StopCircleIcon size={13} />
              ) : (
                <MicIcon size={13} />
              )}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => onChange('')}
              disabled={!value}
              title="Clear prompt"
              aria-label="Clear"
            >
              <TrashIcon size={13} />
            </Button>
            <Button
              size="xs"
              variant="soft"
              tone="accent"
              onClick={() => void onSend(true)}
              disabled={!value}
              title="Paste + submit with Enter (Insert without submit: ⌥Enter)"
              aria-label="Send"
            >
              <SendToAiIcon size={13} />
            </Button>
            {onClose && (
              <Button
                size="xs"
                variant="ghost"
                onClick={onClose}
                title="Close Compose (⌘⇧E · Esc)"
                aria-label="Close compose"
                data-testid="terminal-compose-close"
              >
                <CloseIcon size={13} />
              </Button>
            )}
          </div>
        </div>
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={(e) => {
            // Intercept clipboard files of any type (images, PDFs,
            // arbitrary binaries). Text pastes fall through so
            // newlines / indentation work exactly as expected.
            const items = Array.from(e.clipboardData?.items ?? []);
            const fileItems = items.filter((it) => it.kind === 'file');
            if (fileItems.length === 0) return;
            const files = fileItems
              .map((it) => it.getAsFile())
              .filter((f): f is File => !!f);
            if (files.length === 0) return;
            e.preventDefault();
            void handleFiles(files);
          }}
          onKeyDown={(e) => {
            // Stop keys from reaching the terminal's host keydown
            // listener — otherwise ⌘K would clear the shell while
            // typing here.
            e.stopPropagation();
            if (e.key === 'Enter' && e.altKey) {
              // Opt+Enter = insert without submitting. Keeps the user
              // in compose so they can iterate on the prompt before
              // committing with plain Enter.
              e.preventDefault();
              void onSend(false);
            } else if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void onSend(true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              // Prefer the full dismiss path when the host supports it —
              // Esc then reads as "back to terminal" with Compose hidden,
              // matching the close button. Falls back to the legacy
              // focus-only behaviour for hosts that haven't migrated.
              if (onClose) onClose();
              else onEscape();
            }
          }}
          placeholder="Message · ⏎ send · ⇧⏎ newline · ⌥⏎ insert · Esc back"
          className="w-full resize-none rounded-md px-2 py-1.5 text-body font-mono outline-none t-primary"
          style={{
            // Darker recess against the frosted compose strip so the
            // textarea reads as a proper input field. Still translucent
            // enough that the popup blur shows through subtly.
            background: 'rgba(0, 0, 0, 0.28)',
            border: dragOver
              ? '1px solid var(--stash-accent)'
              : '1px solid var(--color-border-hair, rgba(255,255,255,0.08))',
            height: textareaHeight,
            minHeight: MIN_COMPOSE_HEIGHT,
            maxHeight: MAX_COMPOSE_HEIGHT,
            transition: 'border-color 120ms',
          }}
          spellCheck={false}
        />
      </div>
    );
  },
);
