import { useCallback, useEffect, useRef, useState } from 'react';

/// Lifecycle states the popup UI flips between. `unsupported` means the
/// running webview doesn't expose `webkitSpeechRecognition` — callers
/// should fall back to the MediaRecorder + Whisper roundtrip in that
/// case (older Linux/Windows runtimes, headless test environments).
export type DictationPhase = 'idle' | 'listening' | 'unsupported';

type Options = {
  /// BCP-47 tag fed to `SpeechRecognition.lang`. Apple's on-device
  /// dictation supports a long list; the caller usually wants the
  /// system default which the OS auto-routes when this is omitted.
  lang?: string;
  /// Called with the live transcript as the user speaks. Partial
  /// hypotheses are debounced by the engine so this fires a couple
  /// of times per second at most.
  onInterim?: (text: string) => void;
  /// Called once with the finalised transcript when listening stops.
  /// `text` is the accumulated final + interim — losing the interim
  /// tail would drop the last word in shorter utterances.
  onFinal?: (text: string) => void;
  /// Surfaced to the caller via a toast on engine failures (mic
  /// permission denied, network error, no-speech timeout). The hook
  /// also flips `phase` back to `idle` automatically.
  onError?: (message: string) => void;
};

// ---- Web Speech API shims ---------------------------------------------
// The DOM lib still doesn't ship typings for these, so we declare just
// the surface we touch. Keeping the shapes opaque (no class typing) is
// fine because we only construct and call the methods listed below.

type SpeechRecognitionResult = {
  isFinal: boolean;
  0: { transcript: string };
};

type SpeechRecognitionEvent = {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResult>;
};

type SpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: { error?: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionCtor = new () => SpeechRecognition;

const getCtor = (): SpeechRecognitionCtor | null => {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

/// Live dictation backed by Apple's on-device speech engine via
/// `webkitSpeechRecognition`. No file roundtrip, no Whisper hop —
/// partial transcripts stream as the user speaks. The hook is a thin
/// wrapper around the browser API; lifecycle plumbing lives in one
/// place so the popup component can stay a simple state machine.
export function useDictation(opts: Options = {}) {
  const { lang, onInterim, onFinal, onError } = opts;

  const ctor = useMemoCtor();
  const [phase, setPhase] = useState<DictationPhase>(
    ctor ? 'idle' : 'unsupported',
  );

  const recRef = useRef<SpeechRecognition | null>(null);
  // Accumulated *final* transcript so far. Interim text rides on top
  // and is only stashed into `final` when the engine confirms it.
  const finalRef = useRef('');
  const interimRef = useRef('');
  // Snapshot the latest callbacks so the SpeechRecognition event
  // handlers don't capture stale closures. Re-attaching handlers on
  // every render would tear down the recognition mid-stream.
  const cbRef = useRef({ onInterim, onFinal, onError });
  useEffect(() => {
    cbRef.current = { onInterim, onFinal, onError };
  }, [onInterim, onFinal, onError]);

  const stop = useCallback(() => {
    const r = recRef.current;
    if (!r) return;
    try {
      r.stop();
    } catch {
      /* engine already stopped — `onend` will still fire */
    }
  }, []);

  const cancel = useCallback(() => {
    const r = recRef.current;
    if (!r) return;
    finalRef.current = '';
    interimRef.current = '';
    try {
      r.abort();
    } catch {
      /* ignore — abort is best-effort */
    }
  }, []);

  const start = useCallback(() => {
    if (!ctor) {
      cbRef.current.onError?.('Dictation is not supported in this webview.');
      return;
    }
    if (phase === 'listening') return;
    const r = new ctor();
    if (lang) r.lang = lang;
    r.continuous = true;
    r.interimResults = true;
    recRef.current = r;
    finalRef.current = '';
    interimRef.current = '';

    r.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const chunk = res[0]?.transcript ?? '';
        if (res.isFinal) {
          // Final chunks accumulate with a trailing space so the next
          // hypothesis doesn't glue onto the previous word boundary.
          finalRef.current = `${finalRef.current}${chunk}`.replace(/\s+$/, '') + ' ';
        } else {
          interim += chunk;
        }
      }
      interimRef.current = interim;
      cbRef.current.onInterim?.((finalRef.current + interim).trim());
    };
    r.onerror = (e) => {
      const code = e.error ?? 'unknown';
      // `no-speech` and `aborted` are routine — don't toast them.
      if (code !== 'no-speech' && code !== 'aborted') {
        cbRef.current.onError?.(e.message || code);
      }
    };
    r.onend = () => {
      setPhase('idle');
      const full = (finalRef.current + interimRef.current).trim();
      recRef.current = null;
      if (full.length > 0) cbRef.current.onFinal?.(full);
    };
    try {
      r.start();
      setPhase('listening');
    } catch (e) {
      setPhase('idle');
      cbRef.current.onError?.(e instanceof Error ? e.message : String(e));
    }
  }, [ctor, lang, phase]);

  // Tear down on unmount so a closing popup doesn't leave the mic LED
  // glowing for the next caller.
  useEffect(
    () => () => {
      const r = recRef.current;
      if (r) {
        try {
          r.abort();
        } catch {
          /* ignore */
        }
        recRef.current = null;
      }
    },
    [],
  );

  return {
    phase,
    supported: !!ctor,
    start,
    stop,
    cancel,
  };
}

// Memoise the constructor lookup once per module load — `window.foo`
// can't realistically change at runtime, and the alternative was a
// `useMemo` that re-ran on every render with no input changes.
let cachedCtor: SpeechRecognitionCtor | null | undefined;
const useMemoCtor = (): SpeechRecognitionCtor | null => {
  if (cachedCtor === undefined) cachedCtor = getCtor();
  return cachedCtor;
};
