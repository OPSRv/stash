/* Building blocks for lookahead sequencers (Metronome, Drums) on the shared
 * AudioContext:
 *
 *  - `createWorkerTicker` — a Web Worker interval. Browsers throttle
 *    main-thread timers on hidden pages (down to ~1 Hz), which starves a
 *    lookahead scheduler the moment the popup hides; worker timers aren't
 *    throttled. Falls back to `setInterval` when a `blob:` worker is refused
 *    (hardened CSP) so the sequencer still makes sound.
 *
 *  - `createStallWatchdog` — detects a context WebKit has wedged (stuck
 *    non-running, or 'running' with a frozen `currentTime` after an output
 *    renegotiation) and rebuilds the shared context once `resume()` has had
 *    a fair chance. Without it the sequencer keeps "playing" in silence. */

import { recreateSharedAudioContext } from './sharedAudioContext';

const WORKER_SRC = `
let id = null;
self.onmessage = (e) => {
  if (e.data && e.data.type === 'start') {
    if (id !== null) clearInterval(id);
    id = setInterval(() => self.postMessage('tick'), e.data.ms || 25);
  } else if (e.data && e.data.type === 'stop') {
    if (id !== null) { clearInterval(id); id = null; }
  }
};
`;

export type WorkerTicker = {
  start: () => void;
  stop: () => void;
  /** Stop and release the worker for good (unmount). */
  dispose: () => void;
};

export const createWorkerTicker = (onTick: () => void, ms: number): WorkerTicker => {
  let worker: Worker | null = null;
  let url: string | null = null;
  let fallback: number | null = null;

  const ensureWorker = (): Worker | null => {
    if (worker) return worker;
    if (typeof Worker === 'undefined') return null;
    try {
      url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'application/javascript' }));
      worker = new Worker(url);
      worker.onmessage = () => onTick();
      return worker;
    } catch {
      return null;
    }
  };

  const stop = () => {
    worker?.postMessage({ type: 'stop' });
    if (fallback !== null) {
      window.clearInterval(fallback);
      fallback = null;
    }
  };

  return {
    start: () => {
      const w = ensureWorker();
      if (w) {
        w.postMessage({ type: 'start', ms });
      } else {
        if (fallback !== null) window.clearInterval(fallback);
        fallback = window.setInterval(onTick, ms);
      }
    },
    stop,
    dispose: () => {
      stop();
      worker?.terminate();
      worker = null;
      if (url) URL.revokeObjectURL(url);
      url = null;
    },
  };
};

/** How long the context may stay non-running or frozen (popup visible)
 *  before we rebuild it — covers a normal `resume()` round-trip. */
const STALL_RECOVER_MS = 600;
/** Floor between rebuilds so a missing output device can't thrash. */
const RECREATE_COOLDOWN_MS = 2000;

export type StallVerdict =
  /** Clock is moving — schedule as usual. */
  | 'ok'
  /** Not running; `resume()` was requested. Re-pin the schedule and skip. */
  | 'suspended'
  /** Running but the clock didn't move this tick — scheduling is a no-op. */
  | 'frozen'
  /** The shared context was rebuilt; subscribers of
   *  `onSharedAudioContextReplaced` re-attach. Skip this tick. */
  | 'recreated';

export type StallWatchdog = {
  check: (ctx: AudioContext) => StallVerdict;
  reset: () => void;
};

export const createStallWatchdog = (): StallWatchdog => {
  let stallSince: number | null = null;
  let lastTime = -1;
  let lastRecreate = 0;
  return {
    reset: () => {
      stallSince = null;
      lastTime = -1;
    },
    check: (ctx) => {
      const now = performance.now();
      const running = ctx.state === 'running';
      const frozen = running && ctx.currentTime === lastTime;
      lastTime = ctx.currentTime;
      if (running && !frozen) {
        stallSince = null;
        return 'ok';
      }
      if (stallSince === null) stallSince = now;
      if (!running) ctx.resume().catch(() => {});
      // Only escalate while visible — a hidden WKWebView may legitimately
      // park audio, and a rebuilt context would just park too.
      if (
        now - stallSince > STALL_RECOVER_MS &&
        document.visibilityState === 'visible' &&
        now - lastRecreate > RECREATE_COOLDOWN_MS
      ) {
        lastRecreate = now;
        stallSince = null;
        lastTime = -1;
        recreateSharedAudioContext();
        return 'recreated';
      }
      return running ? 'frozen' : 'suspended';
    },
  };
};
