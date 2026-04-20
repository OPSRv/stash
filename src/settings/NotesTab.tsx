import { Toggle } from '../shared/ui/Toggle';
import { WhisperModelList } from '../modules/whisper/WhisperModelList';
import { SettingRow } from './SettingRow';
import { SettingsSectionHeader } from './SettingsSectionHeader';

interface NotesTabProps {
  autoTranscribe: boolean;
  autoPolish: boolean;
  onToggleAutoTranscribe: (next: boolean) => void;
  onToggleAutoPolish: (next: boolean) => void;
}

export const NotesTab = ({
  autoTranscribe,
  autoPolish,
  onToggleAutoTranscribe,
  onToggleAutoPolish,
}: NotesTabProps) => (
  <div className="max-w-[720px] mx-auto space-y-6">
    <section>
      <SettingsSectionHeader label="VOICE NOTES" />
      <div className="divide-y divide-white/5">
        <SettingRow
          title="Auto-transcribe new recordings"
          description="Run Whisper the moment you stop recording — the transcript lands in the note without an extra click. Silently skipped when no Whisper model is active."
          control={
            <Toggle
              checked={autoTranscribe}
              onChange={onToggleAutoTranscribe}
              label="Auto-transcribe new recordings"
            />
          }
        />
        <SettingRow
          title="Auto-polish transcripts with AI"
          description="After transcribing, send the text through your active AI model to fix typos and punctuation (temperature 0, no rephrasing). Skipped when no AI provider is configured in the AI tab."
          control={
            <Toggle
              checked={autoPolish}
              onChange={onToggleAutoPolish}
              label="Auto-polish transcripts with AI"
            />
          }
        />
      </div>
    </section>
    <section>
      <SettingsSectionHeader label="WHISPER MODEL" />
      <p className="t-tertiary text-meta mb-3">
        Base language: Ukrainian — pick a <span className="t-secondary">multilingual</span> model.
        Speeds estimated for an Intel Mac (2018-class, AVX2). Recommended picks are marked.
      </p>
      <WhisperModelList />
    </section>
  </div>
);
