import { useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';

import { AudioPlayer } from '../../shared/ui/AudioPlayer';
import { TranscriptArea } from '../../shared/ui/TranscriptArea';
import { useTranscription } from '../../shared/hooks/useTranscription';
import type { TranscriptionHandlers } from '../../shared/hooks/useTranscription';
import { formatDuration } from '../../shared/format/duration';
import {
  notesGet,
  notesTranscribeNoteAudio,
  notesSetAudioTranscription,
  type Note,
} from './api';

type Props = {
  note: Note;
  /** Called when a `notes:note_updated` event arrives — parent can re-fetch
   *  the note to reflect the persisted transcription. */
  onNoteUpdated?: () => void;
};

/// Strip shown below the note header when the note has a primary audio
/// recording (`audio_path` is set). Renders an `AudioPlayer` + a
/// `TranscriptArea` wired to the backend Whisper pipeline.
export const NoteAudioStrip = ({ note, onNoteUpdated }: Props) => {
  if (!note.audio_path) return null;

  return (
    <NoteAudioStripInner
      note={note as Note & { audio_path: string }}
      onNoteUpdated={onNoteUpdated}
    />
  );
};

// Inner component — only mounted when audio_path is non-null so the hook
// can reference note.audio_path without a null-check on every render.
const NoteAudioStripInner = ({
  note,
  onNoteUpdated,
}: {
  note: Note & { audio_path: string };
  onNoteUpdated?: () => void;
}) => {
  const subscribe = useCallback(
    (handlers: TranscriptionHandlers) => {
      const fns: Array<Promise<() => void>> = [];

      fns.push(
        listen<{ note_id: number }>('notes:audio_transcribing', (e) => {
          if (e.payload.note_id === note.id) handlers.onStart();
        }),
      );

      fns.push(
        listen<{ note_id: number }>('notes:note_updated', async (e) => {
          if (e.payload.note_id !== note.id) return;
          // Re-fetch the note to get the persisted transcript, then drive
          // the hook's done state so the TranscriptArea updates immediately.
          const fresh = await notesGet(note.id).catch(() => null);
          if (fresh?.audio_transcription != null) {
            handlers.onDone(fresh.audio_transcription);
          }
          onNoteUpdated?.();
        }),
      );

      fns.push(
        listen<{ note_id: number; error: string }>('notes:audio_transcribe_failed', (e) => {
          if (e.payload.note_id === note.id) handlers.onFailed(e.payload.error);
        }),
      );

      return () => {
        fns.forEach((p) => void p.then((fn) => fn()));
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [note.id],
  );

  const { status, transcript, failed, transcribe } = useTranscription({
    initial: note.audio_transcription,
    start: () => notesTranscribeNoteAudio(note.id),
    subscribe,
  });

  return (
    <div className="px-5 pt-2 pb-3 border-b hair flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <AudioPlayer src={note.audio_path} loader="bytes" display="waveform" />
        {note.audio_duration_ms != null && (
          <span className="text-meta t-tertiary tabular-nums shrink-0">
            {formatDuration(note.audio_duration_ms, { unit: 'ms', empty: '', includeHours: 'never' })}
          </span>
        )}
      </div>
      <TranscriptArea
        transcript={transcript}
        transcribing={status === 'running'}
        failed={failed}
        onRetry={transcribe}
        onTranscribe={transcribe}
        onEdit={(t) => notesSetAudioTranscription(note.id, t)}
      />
    </div>
  );
};
