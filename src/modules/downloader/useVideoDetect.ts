import { useCallback, useEffect, useRef, useState } from 'react';
import {
  detect,
  detectQuick,
  type DetectedVideo,
  type QuickDetect,
} from './api';

interface UseVideoDetectResult {
  detecting: boolean;
  elapsedSec: number;
  quick: QuickDetect | null;
  detected: DetectedVideo | null;
  error: string | null;
  run: (url: string) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

/// Owns the "user pasted a URL → tell them what it is" state machine:
/// kicks off an oEmbed quick preview alongside the full yt-dlp round-trip,
/// tracks elapsed time, and debounces against stale responses via an epoch
/// counter so an in-flight detect can't overwrite a newer one.
export const useVideoDetect = (): UseVideoDetectResult => {
  const [detecting, setDetecting] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [quick, setQuick] = useState<QuickDetect | null>(null);
  const [detected, setDetected] = useState<DetectedVideo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const epochRef = useRef(0);

  useEffect(() => {
    if (!startedAt) return;
    const timer = window.setInterval(
      () => setElapsedSec(Math.floor((Date.now() - startedAt) / 1000)),
      200
    );
    return () => window.clearInterval(timer);
  }, [startedAt]);

  const reset = useCallback(() => {
    epochRef.current += 1;
    setDetecting(false);
    setStartedAt(null);
    setElapsedSec(0);
    setQuick(null);
    setDetected(null);
    setError(null);
  }, []);

  const cancel = useCallback(() => {
    epochRef.current += 1;
    setDetecting(false);
    setStartedAt(null);
    setError('Cancelled');
  }, []);

  const run = useCallback(async (url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const myEpoch = ++epochRef.current;
    setDetecting(true);
    setStartedAt(Date.now());
    setElapsedSec(0);
    setError(null);
    setQuick(null);
    setDetected(null);

    // Fire oEmbed quick-preview in parallel — it typically resolves in
    // ~500ms and lets the UI paint title/thumbnail immediately while the
    // full yt-dlp extraction continues.
    detectQuick(trimmed)
      .then((q) => {
        if (epochRef.current === myEpoch && q) setQuick(q);
      })
      .catch(() => {
        // Silent: the full detect will either succeed or report its own error.
      });

    try {
      const result = await detect(trimmed);
      if (epochRef.current !== myEpoch) return;
      setDetected(result);
    } catch (e) {
      if (epochRef.current !== myEpoch) return;
      setError(String(e));
    } finally {
      if (epochRef.current === myEpoch) {
        setDetecting(false);
        setStartedAt(null);
      }
    }
  }, []);

  return { detecting, elapsedSec, quick, detected, error, run, cancel, reset };
};
