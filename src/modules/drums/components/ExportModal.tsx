import { Button } from '../../../shared/ui/Button';
import { Modal } from '../../../shared/ui/Modal';
import type { ReactNode } from 'react';
import { SegmentedControl } from '../../../shared/ui/SegmentedControl';
import { EXPORT_BARS, type ExportFormat } from '../lib/model';

type Props = {
  open: boolean;
  onClose: () => void;
  bars: number;
  format: ExportFormat;
  /** Pattern length in bars — shorter exports would cut the groove. */
  patternBars: 1 | 2;
  ffmpegAvailable: boolean;
  /** Loop duration for the chosen bar count, e.g. "9.6 s". */
  durationLabel: string;
  busy: boolean;
  onChange: (patch: { export_bars?: number; export_format?: ExportFormat }) => void;
  onSave: () => void;
};

export const ExportModal = ({
  open,
  onClose,
  bars,
  format,
  patternBars,
  ffmpegAvailable,
  durationLabel,
  busy,
  onChange,
  onSave,
}: Props) => (
  <Modal open={open} onClose={onClose} ariaLabel="Export drum loop" maxWidth={420}>
    <div className="flex flex-col gap-4">
      <div>
        <div className="t-primary text-title font-semibold">Export loop</div>
        <div className="t-tertiary text-meta">
          Seamless — tails wrap to the start, so the file loops cleanly in a DAW or looper.
        </div>
      </div>

      <Field label="Length" hint={durationLabel}>
        <SegmentedControl<string>
          size="sm"
          value={String(bars)}
          onChange={(v) => onChange({ export_bars: Number(v) })}
          options={EXPORT_BARS.map((b) => ({
            value: String(b),
            label: `${b} bar${b > 1 ? 's' : ''}`,
            disabled: b < patternBars,
            title: b < patternBars ? 'Shorter than the 2-bar pattern' : undefined,
          }))}
          ariaLabel="Loop length in bars"
        />
      </Field>

      <Field
        label="Format"
        hint={
          ffmpegAvailable
            ? format === 'mp3'
              ? 'MP3 320 kbps via ffmpeg.'
              : 'WAV 44.1 kHz · 16-bit stereo.'
            : 'MP3 needs ffmpeg — install it in Settings → Downloads.'
        }
      >
        <SegmentedControl<ExportFormat>
          size="sm"
          value={format}
          onChange={(v) => onChange({ export_format: v })}
          options={[
            { value: 'wav', label: 'WAV' },
            {
              value: 'mp3',
              label: 'MP3',
              disabled: !ffmpegAvailable,
              title: ffmpegAvailable ? undefined : 'Install ffmpeg in Settings → Downloads',
            },
          ]}
          ariaLabel="File format"
        />
      </Field>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button tone="accent" variant="solid" loading={busy} onClick={onSave}>
          Save…
        </Button>
      </div>
    </div>
  </Modal>
);

/** Stacked label → control → hint; the 5-way length switch is too wide to
 *  sit beside its label in a 420px dialog. */
const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <div className="flex flex-col gap-1.5">
    <span className="t-primary text-meta font-medium">{label}</span>
    {children}
    {hint && <span className="t-tertiary text-meta">{hint}</span>}
  </div>
);
