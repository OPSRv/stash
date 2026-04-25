import { useEffect, useState } from 'react';

import { Button } from './Button';
import { Spinner } from './Spinner';
import { Textarea } from './Textarea';

export interface TranscriptAreaLabels {
  transcribing: string;
  failed: string;
  retry: string;
  transcribe: string;
  edit: string;
  save: string;
  cancel: string;
}

const DEFAULT_LABELS: TranscriptAreaLabels = {
  transcribing: 'Транскрибую…',
  failed: '⚠ Не вдалося транскрибувати',
  retry: 'Спробувати ще раз',
  transcribe: 'Транскрибувати',
  edit: 'Edit transcript',
  save: 'Save',
  cancel: 'Cancel',
};

export interface TranscriptAreaProps {
  /** Current saved transcript. Null when none yet. */
  transcript: string | null;
  /** True while the backend is running whisper for this clip. */
  transcribing?: boolean;
  /** True when the most recent attempt errored. */
  failed?: boolean;
  /** Called when the user wants to retry after a failure. */
  onRetry?: () => void;
  /** Called when the user wants to *start* a transcription on a clip
   *  that has none yet. When provided, an idle "Transcribe" trigger is
   *  shown next to (or above) the player. */
  onTranscribe?: () => void;
  /** Called when the user saves an edit. When omitted, the transcript
   *  block is read-only. */
  onEdit?: (next: string) => Promise<void> | void;
  /** Optional className to merge on the outer div. */
  className?: string;
  /** i18n labels — defaults match telegram VoiceItem (Ukrainian). */
  labels?: Partial<TranscriptAreaLabels>;
}

/// Presentational component that shows the full transcript lifecycle:
/// idle → transcribing → (failed | read-only | editing).
/// It is layout-agnostic: callers wrap it in whatever container fits.
export const TranscriptArea = ({
  transcript,
  transcribing = false,
  failed = false,
  onRetry,
  onTranscribe,
  onEdit,
  className = '',
  labels: labelOverrides,
}: TranscriptAreaProps) => {
  const labels: TranscriptAreaLabels = { ...DEFAULT_LABELS, ...labelOverrides };

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(transcript ?? '');

  // Keep draft in sync when transcript changes externally (e.g. after save).
  useEffect(() => {
    if (!editing) setDraft(transcript ?? '');
  }, [transcript, editing]);

  return (
    <div className={`flex flex-col gap-2 ${className}`.trim()}>
      {/* ── Transcribing spinner ───────────────────────────────────── */}
      {transcribing && (
        <div
          className="text-meta text-white/60 flex items-center gap-2"
          role="status"
          aria-live="polite"
        >
          <Spinner size={12} />
          {labels.transcribing}
        </div>
      )}

      {/* ── Failed (no transcript yet) ─────────────────────────────── */}
      {!transcribing && failed && !transcript && (
        <div className="flex items-center gap-2 text-meta text-amber-300/80">
          <span>{labels.failed}</span>
          {onRetry && (
            <Button size="xs" variant="ghost" tone="warning" onClick={onRetry}>
              {labels.retry}
            </Button>
          )}
        </div>
      )}

      {/* ── Idle: no transcript, not transcribing, not failed ─────────*/}
      {!transcribing && !failed && !transcript && onTranscribe && (
        <Button size="xs" variant="soft" tone="accent" onClick={onTranscribe}>
          {labels.transcribe}
        </Button>
      )}

      {/* ── Transcript read-only view ──────────────────────────────── */}
      {transcript && !editing && (
        <div className="flex items-start gap-2 group/transcript">
          <p
            className="flex-1 text-body text-white/90 whitespace-pre-wrap bg-white/3 rounded-md px-3 py-2 border border-white/5"
            onDoubleClick={() => onEdit && setEditing(true)}
            title={onEdit ? 'Double-click to edit' : undefined}
          >
            {transcript}
          </p>
          {onEdit && (
            <div className="opacity-0 group-hover/transcript:opacity-100 focus-within:opacity-100 transition-opacity mt-1">
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setEditing(true)}
                aria-label={labels.edit}
              >
                edit
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ── Transcript edit mode ───────────────────────────────────── */}
      {transcript && editing && onEdit && (
        <div className="flex flex-col gap-2">
          <Textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-h-[72px]"
            aria-label={labels.edit}
          />
          <div className="flex gap-2">
            <Button
              size="xs"
              variant="soft"
              tone="accent"
              onClick={async () => {
                await onEdit(draft);
                setEditing(false);
              }}
            >
              {labels.save}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setDraft(transcript);
                setEditing(false);
              }}
            >
              {labels.cancel}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
