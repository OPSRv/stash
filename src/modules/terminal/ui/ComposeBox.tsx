import { forwardRef, useState } from 'react';

import { Button } from '../../../shared/ui/Button';
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
export const ComposeBox = forwardRef<HTMLTextAreaElement, ComposeBoxProps>(
  function ComposeBox(
    { value, onChange, onSend, onFileAttach, onEscape, voice, compact },
    ref,
  ) {
    const [dragOver, setDragOver] = useState(false);
    const handleFiles = async (files: File[]) => {
      // Sequential so caret placement stays predictable when the
      // consumer inserts an `@path` per file.
      for (const f of files) await onFileAttach(f);
    };

    return (
      <div
        className="border-t hair flex flex-col gap-1.5 px-3 py-2 shrink-0"
        style={{
          // Semi-transparent pane colour + backdrop-blur — the strip
          // reads as frosted-glass chrome over the tinted terminal
          // backdrop instead of a flat grey slab, while still being
          // opaque enough that xterm scrollback can't bleed through.
          background: 'rgba(28, 28, 32, 0.45)',
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
        <div className="flex items-center gap-2 min-w-0">
          <span className="t-tertiary text-meta shrink-0">Compose</span>
          {!compact && (
            <span
              className="t-tertiary text-meta"
              style={{
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                minWidth: 0,
              }}
            >
              · Enter send · ⇧Enter newline · paste / drop any file · Esc back
            </span>
          )}
          {voice.phase === 'recording' && (
            <span
              className="terminal-rec-dot"
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
            <span className="t-danger text-meta" title={voice.error}>
              ⚠️ mic
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
              {voice.phase === 'recording'
                ? compact
                  ? '⏹'
                  : '⏹ Stop'
                : voice.busy
                  ? compact
                    ? '…'
                    : '… Transcribe'
                  : compact
                    ? '🎙'
                    : '🎙 Record'}
            </Button>
            {!compact && (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => onChange('')}
                disabled={!value}
              >
                Clear
              </Button>
            )}
            {!compact && (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => void onSend(false)}
                disabled={!value}
                title="Insert into prompt without submitting"
              >
                Insert
              </Button>
            )}
            <Button
              size="xs"
              variant="soft"
              tone="accent"
              onClick={() => void onSend(true)}
              disabled={!value}
              title="Paste + submit with Enter"
              aria-label="Send"
            >
              {compact ? '➤' : 'Send'}
            </Button>
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
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void onSend(true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onEscape();
            }
          }}
          placeholder="Multi-line prompt. Enter = send · Shift+Enter = newline · Esc = back to terminal."
          rows={5}
          className="w-full resize-none rounded-md px-2 py-1.5 text-body font-mono outline-none t-primary"
          style={{
            // Slightly recessed against the frosted compose strip so the
            // textarea reads as an input field, not a flat continuation
            // of the strip. Semi-transparent lets the chrome blur show
            // through subtly instead of punching a hard black rectangle.
            background: 'rgba(0, 0, 0, 0.15)',
            border: dragOver
              ? '1px solid var(--stash-accent)'
              : '1px solid var(--color-border-hair, rgba(255,255,255,0.08))',
            minHeight: 84,
            maxHeight: 200,
            transition: 'border-color 120ms',
          }}
          spellCheck={false}
        />
      </div>
    );
  },
);
