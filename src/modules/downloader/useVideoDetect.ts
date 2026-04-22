import { useCallback, useEffect, useRef, useState } from 'react';
import {
  detect,
  detectQuick,
  type DetectedVideo,
  type QuickDetect,
} from './api';

/// One in-flight or completed detect invocation. The shell keeps a list of
/// these so pasting a second URL before the first resolves stacks a new
/// card instead of clobbering the previous detect — a common scenario when
/// a user copies several videos in a row and wants to queue them all up.
export interface DetectSession {
  id: string;
  url: string;
  detecting: boolean;
  startedAt: number;
  elapsedSec: number;
  quick: QuickDetect | null;
  detected: DetectedVideo | null;
  error: string | null;
}

interface UseVideoDetectResult {
  sessions: DetectSession[];
  /** Back-compat accessors — the shell's URL bar and keyboard handlers still
   *  think in terms of "the current detect". We expose the freshest session's
   *  fields so existing UI copy doesn't have to learn about the queue. */
  detecting: boolean;
  elapsedSec: number;
  run: (url: string) => void;
  /** Cancel the in-flight detect for a specific session. Leaves the session
   *  in the list with `error: 'Cancelled'` so the card can still show why. */
  cancel: (id: string) => void;
  /** Remove a session from the list (card dismiss). */
  dismiss: (id: string) => void;
  /** Remove all sessions — used when the user nukes the URL bar or a
   *  download starts from a session (that card should go away). */
  clearAll: () => void;
}

const nextId = (() => {
  let n = 0;
  return () => `d${Date.now().toString(36)}-${(++n).toString(36)}`;
})();

/// Owns the "user pasted a URL → tell them what it is" state machine.
/// Each `run(url)` pushes a new `DetectSession`; detects run in parallel on
/// the JS side (the Rust pipeline serialises what it has to internally), so
/// the user can paste several videos and pick quality/download on each
/// without waiting for the first to finish.
export const useVideoDetect = (): UseVideoDetectResult => {
  const [sessions, setSessions] = useState<DetectSession[]>([]);
  /// Always-fresh snapshot of `sessions` for callers that can't depend
  /// on it reactively — `run` needs to dedupe against current state
  /// without growing its useCallback deps (which would churn every
  /// consumer on every session list change).
  const sessionsRef = useRef<DetectSession[]>([]);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  /// Per-session cancel flag: incremented when the user clicks cancel so
  /// the in-flight promise knows to drop its result on return. Keyed by
  /// session id so flipping one doesn't stomp on another.
  const cancelledRef = useRef<Set<string>>(new Set());

  // Tick elapsed seconds for every actively-detecting session. One interval
  // handles all of them — no proliferating timers per card.
  useEffect(() => {
    const anyActive = sessions.some((s) => s.detecting);
    if (!anyActive) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setSessions((prev) =>
        prev.map((s) =>
          s.detecting
            ? { ...s, elapsedSec: Math.floor((now - s.startedAt) / 1000) }
            : s,
        ),
      );
    }, 200);
    return () => window.clearInterval(timer);
  }, [sessions]);

  const dismiss = useCallback((id: string) => {
    cancelledRef.current.add(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    setSessions((prev) => {
      prev.forEach((s) => cancelledRef.current.add(s.id));
      return [];
    });
  }, []);

  const cancel = useCallback((id: string) => {
    cancelledRef.current.add(id);
    setSessions((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, detecting: false, error: s.error ?? 'Cancelled' } : s,
      ),
    );
  }, []);

  const run = useCallback((url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    // Dedupe against any existing live session for this exact URL.
    // React.StrictMode double-invokes mount effects in dev, so `run`
    // can land twice back-to-back for the same URL (clipboard copy →
    // PopupShell prefill + DownloadsShell mount read). A user pasting
    // the same URL twice shouldn't spawn a second detect either.
    if (
      sessionsRef.current.some(
        (s) => s.url === trimmed && (s.detecting || s.detected),
      )
    ) {
      return;
    }
    const id = nextId();
    const session: DetectSession = {
      id,
      url: trimmed,
      detecting: true,
      startedAt: Date.now(),
      elapsedSec: 0,
      quick: null,
      detected: null,
      error: null,
    };
    setSessions((prev) => [...prev, session]);

    // Fire oEmbed quick-preview in parallel — it typically resolves in
    // ~500 ms and lets the UI paint title/thumbnail immediately while the
    // full yt-dlp extraction continues.
    detectQuick(trimmed)
      .then((q) => {
        if (cancelledRef.current.has(id) || !q) return;
        setSessions((prev) =>
          prev.map((s) => (s.id === id ? { ...s, quick: q } : s)),
        );
      })
      .catch(() => {
        // Silent: the full detect will either succeed or report its own error.
      });

    detect(trimmed)
      .then((result) => {
        if (cancelledRef.current.has(id)) return;
        setSessions((prev) =>
          prev.map((s) =>
            s.id === id
              ? { ...s, detected: result, detecting: false }
              : s,
          ),
        );
      })
      .catch((e) => {
        if (cancelledRef.current.has(id)) return;
        setSessions((prev) =>
          prev.map((s) =>
            s.id === id ? { ...s, error: String(e), detecting: false } : s,
          ),
        );
      });
  }, []);

  const detectingAny = sessions.some((s) => s.detecting);
  // The URL bar shows elapsed time for the latest in-flight detect (the
  // one a user is most likely waiting on); older detects still show their
  // own time in their own card.
  const latestElapsed =
    [...sessions].reverse().find((s) => s.detecting)?.elapsedSec ?? 0;

  return {
    sessions,
    detecting: detectingAny,
    elapsedSec: latestElapsed,
    run,
    cancel,
    dismiss,
    clearAll,
  };
};
