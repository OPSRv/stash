import { useState } from 'react';
import { Modal } from '../../shared/ui/Modal';
import { Button } from '../../shared/ui/Button';
import { SegmentedControl } from '../../shared/ui/SegmentedControl';
import { NumberInput } from '../../shared/ui/NumberInput';
import { Toggle } from '../../shared/ui/Toggle';
import { Textarea } from '../../shared/ui/Textarea';
import type { TranscribeArgs, TranscribeFormat } from './api';

type TranscribeOptionsModalProps = {
  open: boolean;
  filename: string;
  onCancel: () => void;
  onConfirm: (opts: Omit<TranscribeArgs, 'inputPath'>) => void;
  busy?: boolean;
};

const DEFAULT_PROMPT =
  'Виправляй лише орфографічні та пунктуаційні помилки, не змінюй слова чи зміст.';

/// Pre-flight options for `transcribeToFile`. Three knobs the user
/// asked for, surfaced as a single confirm dialog so the action picker
/// stays clean for the common one-click path.
///
///   * `format` — `.txt` (raw) or `.md` (markdown with a title heading)
///   * `diarize` + `speakers` — opt-in speaker labels with optional
///     pinned count (1–10 or auto)
///   * `aiPolish` + `prompt` — single-shot LLM pass that fixes typos
///     and punctuation without rewording. Custom prompt overrides the
///     default safety wording when expanded.
///   * `saveAsNote` — also stash the transcript as a Note row.
export function TranscribeOptionsModal({
  open,
  filename,
  onCancel,
  onConfirm,
  busy,
}: TranscribeOptionsModalProps) {
  const [format, setFormat] = useState<TranscribeFormat>('md');
  const [diarize, setDiarize] = useState(false);
  const [speakers, setSpeakers] = useState<number | null>(null);
  const [aiPolish, setAiPolish] = useState(false);
  const [customPromptOpen, setCustomPromptOpen] = useState(false);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [saveAsNote, setSaveAsNote] = useState(true);

  const submit = () => {
    onConfirm({
      format,
      diarize,
      numSpeakers: diarize && speakers && speakers > 0 ? speakers : undefined,
      aiPolish,
      aiPrompt: aiPolish && customPromptOpen ? prompt : undefined,
      saveAsNote,
    });
  };

  return (
    <Modal open={open} onClose={onCancel} ariaLabel="Transcribe options" maxWidth={460}>
      <div className="flex flex-col gap-4">
        <div>
          <div className="t-primary text-title font-semibold">Transcribe</div>
          <div className="t-tertiary text-meta truncate">{filename}</div>
        </div>

        <Row label="Format">
          <SegmentedControl<TranscribeFormat>
            size="sm"
            value={format}
            onChange={setFormat}
            options={[
              { value: 'txt', label: '.txt' },
              { value: 'md', label: '.md' },
            ]}
            ariaLabel="Transcript format"
          />
        </Row>

        <Row
          label="Speaker labels"
          hint={
            diarize
              ? 'Whisper output is split per speaker turn (Спікер 1/2/…).'
              : 'Off — single flat transcript.'
          }
        >
          <Toggle checked={diarize} onChange={setDiarize} label="Diarize speakers" />
        </Row>

        {diarize && (
          <Row
            label="Speakers"
            hint="Leave empty for auto — the diarizer clusters by similarity."
          >
            <div className="w-24">
              <NumberInput
                size="sm"
                value={speakers}
                onChange={setSpeakers}
                min={1}
                max={10}
                placeholder="auto"
                ariaLabel="Number of speakers"
              />
            </div>
          </Row>
        )}

        <Row
          label="AI polish"
          hint="Active AI provider fixes typos and punctuation. Wording and meaning stay intact."
        >
          <Toggle checked={aiPolish} onChange={setAiPolish} label="Run AI polish" />
        </Row>

        {aiPolish && (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setCustomPromptOpen((v) => !v)}
              className="text-meta opacity-70 hover:opacity-100 text-left"
            >
              {customPromptOpen ? '− Hide custom prompt' : '+ Custom prompt'}
            </button>
            {customPromptOpen && (
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.currentTarget.value)}
                rows={3}
                aria-label="Polish prompt"
              />
            )}
          </div>
        )}

        <Row
          label="Save as note"
          hint="Adds the transcript as a row in the Notes tab."
        >
          <Toggle checked={saveAsNote} onChange={setSaveAsNote} label="Save as note" />
        </Row>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" tone="neutral" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="solid" tone="accent" onClick={submit} disabled={busy}>
            {busy ? 'Transcribing…' : 'Transcribe'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

type RowProps = {
  label: string;
  hint?: string;
  children: React.ReactNode;
};

function Row({ label, hint, children }: RowProps) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex flex-col min-w-0 flex-1">
        <span className="t-primary text-meta font-medium">{label}</span>
        {hint && <span className="t-tertiary text-meta">{hint}</span>}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}
