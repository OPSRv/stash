import { useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useTranscription } from '../../shared/hooks/useTranscription';
import { TranscriptArea } from '../../shared/ui/TranscriptArea';
import { detectFileKind } from '../../shared/util/fileKind';
import { listItems, parseFileMeta, setTranscription, transcribeItem } from './api';
import type { ClipboardItem } from './api';
import type { TranscriptionHandlers } from '../../shared/hooks/useTranscription';

/// Returns true when a clipboard item contains exactly one file whose
/// kind is `audio` — the only case where Whisper transcription makes
/// sense. Mirrors the backend guard in `clipboard_transcribe_item`.
export const isSingleAudioItem = (item: ClipboardItem): boolean => {
  if (item.kind !== 'file') return false;
  const meta = parseFileMeta(item);
  if (!meta || meta.files.length !== 1) return false;
  const file = meta.files[0]!;
  return detectFileKind({ name: file.name, mime: file.mime }).kind === 'audio';
};

type Props = {
  /** Clipboard item id. */
  itemId: number;
  /** Initial transcription value (from the loaded ClipboardItem). */
  initial: string | null;
  className?: string;
};

/// Wires useTranscription to the clipboard backend for a single audio
/// file item. Listens for clipboard:transcribing / clipboard:item_updated
/// / clipboard:transcribe_failed events filtered to this item's id.
///
/// Rendered below the file row when the item contains exactly one audio
/// file. Never shown for non-audio or multi-file rows (callers must gate).
export const AudioItemTranscript = ({ itemId, initial, className }: Props) => {
  const start = useCallback(() => transcribeItem(itemId), [itemId]);

  const subscribe = useCallback(
    (handlers: TranscriptionHandlers) => {
      // Three event listeners for the full lifecycle. All are filtered
      // to this specific item so the component is safe to mount multiple
      // times for different rows simultaneously.
      const transcribingP = listen<{ id: number } | number>(
        'clipboard:transcribing',
        (e) => {
          const id =
            typeof e.payload === 'object' && e.payload !== null
              ? (e.payload as { id: number }).id
              : (e.payload as number);
          if (id === itemId) handlers.onStart();
        },
      );

      const updatedP = listen<{ id: number } | number>(
        'clipboard:item_updated',
        async (e) => {
          const id =
            typeof e.payload === 'object' && e.payload !== null
              ? (e.payload as { id: number }).id
              : (e.payload as number);
          if (id !== itemId) return;
          // Re-fetch the item to get the latest transcription. There is no
          // per-item getter in the API so we use listItems() and find by id —
          // the list is small and already cached in the Rust layer.
          try {
            const list = await listItems();
            const updated = list.find((i) => i.id === itemId);
            handlers.onDone(updated?.transcription ?? '');
          } catch {
            // If the list fetch fails we still signal done with empty text
            // rather than leaving the status stuck at 'running'.
            handlers.onDone('');
          }
        },
      );

      const failedP = listen<{ id: number; error: string }>(
        'clipboard:transcribe_failed',
        (e) => {
          if (e.payload.id === itemId) handlers.onFailed(e.payload.error);
        },
      );

      return () => {
        transcribingP.then((fn) => fn()).catch(() => {});
        updatedP.then((fn) => fn()).catch(() => {});
        failedP.then((fn) => fn()).catch(() => {});
      };
    },
    [itemId],
  );

  const { status, transcript, failed, transcribe } = useTranscription({
    initial,
    start,
    subscribe,
  });

  return (
    <TranscriptArea
      transcript={transcript}
      transcribing={status === 'running'}
      failed={failed}
      onRetry={transcribe}
      onTranscribe={transcribe}
      onEdit={(text) => setTranscription(itemId, text || null)}
      className={className}
    />
  );
};
