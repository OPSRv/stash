/**
 * Single application-wide realtime `AudioContext`.
 *
 * macOS / WKWebView renegotiates the audio hardware — output sample rate,
 * audio-session category, Bluetooth A2DP↔HFP profile — whenever a *second*
 * `AudioContext` spins up or a microphone opens via `getUserMedia`. A context
 * that is already playing (e.g. the Metronome) caught in that renegotiation
 * drifts and stutters: this is the "metronome тупить the moment the recorder
 * starts" bug — the Recorder used to mint its own context + open the mic, which
 * forced the device rate to follow the mic and left the metronome's clock out
 * of sync with the hardware.
 *
 * Routing every module's realtime audio through ONE shared context removes the
 * inter-context renegotiation: the context is created once at the device rate,
 * and every later graph (mic capture, tuner, chord playback) attaches to the
 * same clock instead of fighting it. Safari/WKWebView also caps concurrent
 * contexts (~4) and degrades when several coexist, so a singleton is strictly
 * better there too.
 *
 * Lifetime contract: created lazily (nothing heavy on popup-open — perf
 * elephant) and kept for the whole app. Modules build and tear down their OWN
 * nodes (disconnect on cleanup) but **must never `close()` it** — closing
 * silences every other module sharing it. `releaseSharedAudioContext` exists
 * only so tests can reset the singleton between runs.
 *
 * Idle suspend: a running context keeps WebKit's GPU-process audio I/O thread
 * cycling forever, even in silence. Left like that for hours (popup hidden,
 * system under memory pressure) the I/O thread overloads on every cycle and
 * WebKit's audio path eventually wedges — Stash goes silent until relaunch.
 * So the context is suspended once nothing has used it for `IDLE_SUSPEND_MS`:
 * - one-shot sounds (chord/drum previews) just call `getSharedAudioContext` /
 *   `resumeSharedAudioContext`, which counts as activity;
 * - long-running consumers (sequencers, mic capture, stem playback) declare
 *   `setSharedAudioHold(key, true)` while active and `false` when done.
 */
let shared: AudioContext | null = null;

/** Quiet time before an unheld context is suspended. Long enough to cover the
 *  release tail of any one-shot and a bar of the slowest chord progression. */
const IDLE_SUSPEND_MS = 30_000;
const holds = new Set<string>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

const armIdleSuspend = () => {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
  if (holds.size > 0) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (holds.size === 0 && shared?.state === 'running') shared.suspend().catch(() => {});
  }, IDLE_SUSPEND_MS);
};

/** The shared context, created on first use with the WebKit-prefixed ctor when
 *  the standard one is absent (older WKWebView). Counts as audio activity. */
export const getSharedAudioContext = (): AudioContext => {
  if (!shared) {
    const Ctor =
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
      AudioContext;
    shared = new Ctor();
  }
  armIdleSuspend();
  return shared;
};

/** Keep the shared context awake while `key` is active (a sequencer playing,
 *  a mic open, stems playing). Idempotent per key; dropping the last hold
 *  starts the idle-suspend countdown. Taking a hold resumes the context. */
export const setSharedAudioHold = (key: string, on: boolean): void => {
  if (on) {
    holds.add(key);
    if (shared && shared.state !== 'running') shared.resume().catch(() => {});
  } else {
    holds.delete(key);
  }
  armIdleSuspend();
};

type ReplacedListener = (next: AudioContext) => void;
const replacedListeners = new Set<ReplacedListener>();

/** Subscribe to "the shared context was rebuilt". Consumers that cache nodes
 *  (master gains, compressors) must drop them and rebuild on `next`. Returns
 *  the unsubscribe fn. */
export const onSharedAudioContextReplaced = (cb: ReplacedListener): (() => void) => {
  replacedListeners.add(cb);
  return () => {
    replacedListeners.delete(cb);
  };
};

/** Last-resort recovery for a context WebKit has wedged: `state` stuck on
 *  'interrupted'/'suspended' after `resume()`, or 'running' with a frozen
 *  `currentTime` (seen after output-device / sample-rate renegotiation, sleep
 *  /wake, Bluetooth profile flips). `resume()` cannot revive those — only a
 *  fresh context can. Closes the old one, builds a new one and notifies every
 *  subscriber so it can re-attach its graph. Call only when the context is
 *  demonstrably dead — never as routine housekeeping. */
export const recreateSharedAudioContext = (): AudioContext => {
  const old = shared;
  shared = null;
  old?.close().catch(() => {});
  const next = getSharedAudioContext();
  next.resume().catch(() => {});
  replacedListeners.forEach((cb) => cb(next));
  return next;
};

/** Best-effort resume — the context can start (or be left) suspended by the
 *  autoplay policy or a macOS audio-session interruption. Safe to call from any
 *  user gesture; never rejects. Returns the shared context for chaining. */
export const resumeSharedAudioContext = (): AudioContext => {
  const ctx = getSharedAudioContext();
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
  return ctx;
};

/** Test-only: drop and close the singleton so each test starts from a clean
 *  context. Never call from app code — it would tear the shared graph out from
 *  under every other module. */
export const releaseSharedAudioContext = (): Promise<void> => {
  const ctx = shared;
  shared = null;
  replacedListeners.clear();
  holds.clear();
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
  return ctx ? ctx.close().catch(() => {}) : Promise.resolve();
};
