import { useMemo } from 'react';
import { accent } from '../../shared/theme/accent';
import { IconButton } from '../../shared/ui/IconButton';
import { CloseIcon, ExternalIcon, SpeakerIcon, WaveformIcon } from '../../shared/ui/icons';
import type { ConverterPreset } from './api';
import { isVideoFile } from './api';

type ActionPickerProps = {
  file: string;
  presets: ConverterPreset[];
  onConvert: (presetId: string) => void;
  onTranscribe: () => void;
  onSeparate: () => void;
  onCancel: () => void;
  busyKind?: 'convert' | 'transcribe' | null;
};

/// Inline action grid shown right under the DropZone whenever the user
/// has a file selected but hasn't picked an action yet. Three columns:
///   * Convert — one card per preset (audio first, then video).
///   * Transcribe — runs the active whisper model and writes a `.txt`.
///   * Separate — cross-tab handoff to the stems module.
///
/// For video inputs the picker also surfaces "Extract audio (.m4a)"
/// at the top of the audio column — same backend command, different
/// label so the user doesn't have to think about which audio preset
/// matches "I just want the soundtrack out of this clip".
export function ActionPicker({
  file,
  presets,
  onConvert,
  onTranscribe,
  onSeparate,
  onCancel,
  busyKind,
}: ActionPickerProps) {
  const filename = useMemo(() => {
    const i = file.lastIndexOf('/');
    return i < 0 ? file : file.slice(i + 1);
  }, [file]);

  const isVideo = isVideoFile(file);

  const audio = useMemo(
    () => presets.filter((p) => p.kind === 'audio' || p.kind === 'extract_audio'),
    [presets],
  );
  const video = useMemo(() => presets.filter((p) => p.kind === 'video'), [presets]);

  // Strip the extract-audio preset for audio-only inputs — extracting
  // audio from an audio file is meaningless and would just confuse the
  // picker.
  const audioVisible = useMemo(
    () => (isVideo ? audio : audio.filter((p) => p.kind !== 'extract_audio')),
    [audio, isVideo],
  );

  return (
    <div
      data-testid="converter-action-picker"
      className="flex flex-col gap-3 rounded-lg border [border-color:var(--hairline)] p-3 [background:var(--bg-row-active)]"
    >
      <div className="flex items-center gap-3">
        <div
          className="w-8 h-8 rounded-md flex items-center justify-center shrink-0"
          style={{
            background: accent(0.18),
            color: 'rgb(var(--stash-accent-rgb))',
          }}
          aria-hidden
        >
          {isVideo ? <ExternalIcon size={14} /> : <SpeakerIcon size={14} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="t-primary text-body truncate font-medium">{filename}</div>
          <div className="t-tertiary text-meta">
            {isVideo ? 'Video' : 'Audio'} · pick an action below
          </div>
        </div>
        <IconButton title="Discard selection" onClick={onCancel}>
          <CloseIcon size={13} />
        </IconButton>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Column
          title="Audio"
          subtitle="Convert / extract"
          presets={audioVisible}
          onPick={onConvert}
          disabled={busyKind !== null && busyKind !== undefined}
        />
        <Column
          title="Video"
          subtitle="Re-encode"
          presets={video}
          onPick={onConvert}
          disabled={busyKind !== null && busyKind !== undefined}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <ActionCard
          title="Transcribe to .txt"
          description="Whisper writes a transcript next to the file"
          icon={<WaveformIcon size={14} />}
          onClick={onTranscribe}
          busy={busyKind === 'transcribe'}
        />
        <ActionCard
          title="Separate stems →"
          description="Hand off to the Stems tab for demucs"
          icon={<SpeakerIcon size={14} />}
          onClick={onSeparate}
        />
      </div>
    </div>
  );
}

type ColumnProps = {
  title: string;
  subtitle: string;
  presets: ConverterPreset[];
  onPick: (presetId: string) => void;
  disabled?: boolean;
};

function Column({ title, subtitle, presets, onPick, disabled }: ColumnProps) {
  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="flex items-baseline justify-between">
        <span className="t-primary text-meta font-medium">{title}</span>
        <span className="t-tertiary text-meta">{subtitle}</span>
      </div>
      <div className="flex flex-col gap-1">
        {presets.map((p) => (
          <PresetButton key={p.id} preset={p} onPick={onPick} disabled={disabled} />
        ))}
      </div>
    </div>
  );
}

type PresetButtonProps = {
  preset: ConverterPreset;
  onPick: (presetId: string) => void;
  disabled?: boolean;
};

function PresetButton({ preset, onPick, disabled }: PresetButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onPick(preset.id)}
      data-testid={`converter-preset-${preset.id}`}
      className="group flex flex-col items-start gap-0.5 rounded-md border [border-color:var(--hairline)] px-3 py-2 text-left transition-colors hover:[background:var(--bg-row-hover)] disabled:cursor-not-allowed disabled:opacity-50 ring-focus"
    >
      <span className="t-primary text-meta font-medium">{preset.label}</span>
      <span className="t-tertiary text-meta">{preset.description}</span>
    </button>
  );
}

type ActionCardProps = {
  title: string;
  description: string;
  icon: React.ReactNode;
  onClick: () => void;
  busy?: boolean;
};

function ActionCard({ title, description, icon, onClick, busy }: ActionCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex flex-1 items-center gap-3 rounded-md border [border-color:var(--hairline)] px-3 py-2 text-left transition-colors hover:[background:var(--bg-row-hover)] disabled:cursor-not-allowed disabled:opacity-50 ring-focus min-w-0"
    >
      <div
        className="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
        style={{
          background: accent(0.14),
          color: 'rgb(var(--stash-accent-rgb))',
        }}
        aria-hidden
      >
        {icon}
      </div>
      <div className="flex flex-col min-w-0">
        <span className="t-primary text-meta font-medium truncate">
          {busy ? 'Working…' : title}
        </span>
        <span className="t-tertiary text-meta truncate">{description}</span>
      </div>
    </button>
  );
}
