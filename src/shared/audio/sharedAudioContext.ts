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
 */
let shared: AudioContext | null = null;

/** The shared context, created on first use with the WebKit-prefixed ctor when
 *  the standard one is absent (older WKWebView). */
export const getSharedAudioContext = (): AudioContext => {
  if (!shared) {
    const Ctor =
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
      AudioContext;
    shared = new Ctor();
  }
  return shared;
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
  return ctx ? ctx.close().catch(() => {}) : Promise.resolve();
};
