import { useCallback, useRef, useState } from 'react';
import type { ToastInput } from '../../shared/ui/Toast';
import { translate } from './api';

export interface LiveResult {
  original: string;
  translated: string;
  from: string;
  to: string;
}

interface RunTranslateArgs {
  onToast: (toast: ToastInput) => unknown;
  onAnnounce: (msg: string) => void;
}

interface RunTranslateApi {
  liveResult: LiveResult | null;
  setLiveResult: (value: LiveResult | null) => void;
  isBusy: boolean;
  run: (text: string, to: string, from?: string) => Promise<void>;
  reset: () => void;
}

/// Runs manual / auto translations and owns the live-result state. A
/// monotonic request id drops stale IPC responses so a slow older call
/// can't overwrite a freshly set result.
export const useRunTranslate = ({ onToast, onAnnounce }: RunTranslateArgs): RunTranslateApi => {
  const [liveResult, setLiveResult] = useState<LiveResult | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const requestIdRef = useRef(0);

  const run = useCallback(
    async (rawText: string, to: string, from?: string) => {
      const text = rawText.trim();
      if (!text) return;
      const myId = ++requestIdRef.current;
      setIsBusy(true);
      try {
        const result = await translate(text, to, from);
        if (requestIdRef.current !== myId) return;
        setLiveResult({
          original: result.original,
          translated: result.translated,
          from: result.from,
          to: result.to,
        });
        onAnnounce('Translation ready');
      } catch (error) {
        if (requestIdRef.current !== myId) return;
        console.error('translate failed', error);
        onToast({
          title: 'Translate failed',
          description: String(error),
          variant: 'error',
          action: { label: 'Retry', onClick: () => void run(text, to, from) },
        });
      } finally {
        if (requestIdRef.current === myId) setIsBusy(false);
      }
    },
    [onAnnounce, onToast],
  );

  const reset = useCallback(() => {
    requestIdRef.current += 1;
    setLiveResult(null);
  }, []);

  return { liveResult, setLiveResult, isBusy, run, reset };
};
