import { useCallback, useEffect, useState } from 'react';

export interface TranscriptionHandlers {
  onStart: () => void;
  onDone: (transcript: string) => void;
  onFailed: (error: string) => void;
}

export interface UseTranscriptionParams {
  /** Initial saved transcript from the row. */
  initial: string | null;
  /** Calls the backend command — returns nothing; the hook waits for an
   *  event-driven update via `subscribe` instead.
   *  Throws on synchronous error (e.g. validation). */
  start: () => Promise<void>;
  /** Subscribe to transcription events for THIS row.
   *  Return an unsubscribe fn. */
  subscribe: (handlers: TranscriptionHandlers) => () => void;
}

export interface UseTranscriptionReturn {
  status: 'idle' | 'running' | 'error';
  transcript: string | null;
  failed: boolean;
  /** Kick off a transcription. Resets error state, then calls `start()`. */
  transcribe: () => Promise<void>;
}

/// Wraps the per-module backend transcription call with a tidy React
/// interface. Drives `status` + `transcript` from event callbacks rather
/// than from the `start()` return value — matching the telegram pattern
/// where Whisper results arrive via Tauri events.
export function useTranscription({
  initial,
  start,
  subscribe,
}: UseTranscriptionParams): UseTranscriptionReturn {
  const [transcript, setTranscript] = useState<string | null>(initial);
  const [status, setStatus] = useState<'idle' | 'running' | 'error'>('idle');

  // Wire event subscriptions for the lifetime of this hook instance.
  useEffect(() => {
    const unsub = subscribe({
      onStart: () => setStatus('running'),
      onDone: (t) => {
        setTranscript(t);
        setStatus('idle');
      },
      onFailed: (_err) => {
        setStatus('error');
      },
    });
    return unsub;
    // subscribe is expected to be stable (e.g. useCallback / module-level fn).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const transcribe = useCallback(async () => {
    // Reset error before retrying.
    setStatus('idle');
    try {
      await start();
    } catch {
      setStatus('error');
    }
  }, [start]);

  return {
    status,
    transcript,
    failed: status === 'error',
    transcribe,
  };
}
