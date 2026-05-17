import './separator.css';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { Button } from '../../shared/ui/Button';
import { RangeSlider } from '../../shared/ui/RangeSlider';
import { TrackToggle } from '../../shared/ui/TrackToggle';
import { TransportButton } from '../../shared/ui/TransportButton';
import { IconButton } from '../../shared/ui/IconButton';
// IconButton kept for the per-lane action strip (Reveal / Embed / Copy / MIDI).
import { useToast } from '../../shared/ui/Toast';
import { CopyIcon, ExternalIcon, NoteIcon, PauseIcon, PlayIcon, TrashIcon } from '../../shared/ui/icons';
import { revealFile } from '../../shared/util/revealFile';
import { dragIconPath, mediaStreamUrl, mixdown, readPeaks, STEM_LABELS, stemColor, writePeaks, type ChordSegment } from './api';

interface StemMixerProps {
  /// Stable identifier for the job whose stems we're mixing. Used as
  /// the localStorage key for mixer state (volumes, mute/solo,
  /// master, beat-grid toggle, loop region) so the user returns to
  /// the same mix every time they re-open this job. Empty string =
  /// don't persist.
  jobId: string;
  /// Ordered list of stems. Component renders one lane per entry, in
  /// the supplied order. Re-running the parent with a different set
  /// resets transport state — we treat the component as bound to a
  /// concrete job.
  stems: { name: string; path: string }[];
  /// Optional duration hint (seconds) used while audio buffers are
  /// still decoding so the transport / waveforms can size themselves
  /// without a layout shift once peaks come in.
  durationHint?: number;
  /// Per-stem actions surfaced as hover-revealed icon buttons on each
  /// lane. Receiving them as props lets CompletedRow keep its shared
  /// helpers (clipboard, toast, ipc) in one place; the mixer just
  /// fires the callback when the user clicks the icon.
  onReveal: (path: string) => void;
  onCopyPath: (path: string) => void;
  onCopyEmbed: (path: string, stemName: string) => void;
  onExtractMidi: (path: string, stemName: string) => void;
  /// `name` of the stem currently being converted to MIDI, or null.
  /// Used to disable every MIDI button while one is running so the
  /// user can't queue two simultaneous basic-pitch runs.
  midiBusy: string | null;
  /// Delete the stem file from disk and drop the lane. Parent should
  /// guard with a confirm dialog — once accepted, the backend
  /// re-emits the job with the stem removed and the lane vanishes.
  onDelete: (path: string, stemName: string) => void;
  /// Beat times in seconds (librosa output, ascending). When present,
  /// the mixer renders thin vertical lines on each lane waveform at
  /// every beat; the user can toggle the overlay via a transport
  /// button. Empty / missing → toggle is hidden.
  beats?: number[];
  /// Detected tempo in BPM. Surfaced as a small badge in the
  /// transport so the practising user can read it at a glance, and
  /// used by `setLoopRange` to snap the marquee endpoints to the
  /// nearest beat when the user holds the loop without explicit
  /// snap configuration.
  bpm?: number;
  /// Detected chord segments, if the user has already run chord
  /// detection on this job. Rendered as a thin ribbon above the
  /// lanes; clicking a segment seeks to its start.
  chords?: ChordSegment[];
  /// Callback to trigger chord detection. Hidden when `chords` is
  /// already populated. `chordsBusy` drives the loading state.
  onDetectChords?: () => void;
  chordsBusy?: boolean;
}

type LaneState = {
  /// User-set linear gain (0..1.5). >1 boosts a bit for quiet stems.
  volume: number;
  muted: boolean;
  /// Any number of stems can be solo'd. When at least one stem is
  /// solo, every non-solo stem is silenced regardless of its own
  /// mute flag, and solo'd stems play even if their mute is on
  /// (solo overrides mute — Logic / Ableton / Pro Tools semantics).
  solo: boolean;
};

const DEFAULT_LANE: LaneState = { volume: 1, muted: false, solo: false };

/// Snapshot persisted to localStorage keyed by jobId. Versioned with
/// `v` so a future schema change can ignore stale blobs instead of
/// throwing. Loop+beat-grid toggles live here too — they're UI
/// concerns, not pipeline state, so the renderer owns them.
type PersistedMixerState = {
  v: 1;
  master: number;
  showBeats: boolean;
  loop: { a: number; b: number } | null;
  lanes: Record<string, LaneState>;
};

const persistKey = (jobId: string) => `stash:separator:mixer:${jobId}`;

/// Module-level cache for the drag ghost icon path — one IPC call per
/// session is plenty. The promise itself is cached so concurrent first
/// drags share a single resolution.
let dragIconPromise: Promise<string> | null = null;
const resolveDragIcon = () => {
  if (!dragIconPromise) {
    dragIconPromise = dragIconPath().catch((e) => {
      dragIconPromise = null;
      throw e;
    });
  }
  return dragIconPromise;
};

/// Begin a native drag-out for the given stem path. macOS requires the
/// drag session to start synchronously inside a real mouse-down event,
/// so we eagerly call `startDrag` and let the plugin take over the
/// pointer. The ghost icon resolution is awaited inline — first drag
/// of a session pays one IPC round-trip, subsequent drags are instant.
async function startStemDrag(stemPath: string) {
  try {
    const { startDrag } = await import('@crabnebula/tauri-plugin-drag');
    const icon = await resolveDragIcon();
    await startDrag({ item: [stemPath], icon });
  } catch (e) {
    // Silent best-effort — a failed drag (e.g. plugin not present in a
    // browser-only dev build, ghost icon write blocked) shouldn't toast
    // because the user is mid-gesture; they'll re-try if they meant it.
    console.warn('[stems] drag-out failed', e);
  }
}

function loadPersisted(jobId: string): PersistedMixerState | null {
  if (!jobId) return null;
  try {
    const raw = localStorage.getItem(persistKey(jobId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedMixerState;
    if (parsed.v !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/// Number of waveform bars per lane. 600 fits a ~900 px popup nicely
/// without over-sampling and keeps draw time at ~1 ms.
const PEAK_BUCKETS = 600;

/// Lightweight peak extractor — splits the decoded buffer into
/// `buckets` chunks and records the abs-max sample per chunk after
/// mixing channels down to mono. Returns values in [0, 1].
function computePeaks(buffer: AudioBuffer, buckets: number): Float32Array {
  const length = buffer.length;
  const channels = buffer.numberOfChannels;
  const samplesPerBucket = Math.max(1, Math.floor(length / buckets));
  const peaks = new Float32Array(buckets);
  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));
  for (let i = 0; i < buckets; i++) {
    const start = i * samplesPerBucket;
    const end = Math.min(length, start + samplesPerBucket);
    let max = 0;
    for (let j = start; j < end; j++) {
      let sample = 0;
      for (let c = 0; c < channels; c++) sample += Math.abs(data[c][j]);
      sample /= channels;
      if (sample > max) max = sample;
    }
    peaks[i] = max;
  }
  return peaks;
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function StemMixer({
  jobId,
  stems,
  durationHint,
  onReveal,
  onCopyPath,
  onCopyEmbed,
  onExtractMidi,
  midiBusy,
  onDelete,
  beats,
  bpm,
  chords,
  onDetectChords,
  chordsBusy,
}: StemMixerProps) {
  const { toast } = useToast();

  // Web Audio graph — single AudioContext per mixer instance. We rebuild
  // BufferSource nodes on every play / seek (sources are one-shot per
  // WebAudio spec), but the GainNodes and the AudioContext itself
  // outlive playback so volume/mute changes apply instantly even while
  // paused.
  const ctxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const laneGainRef = useRef<Map<string, GainNode>>(new Map());
  const buffersRef = useRef<Map<string, AudioBuffer>>(new Map());
  const sourcesRef = useRef<Map<string, AudioBufferSourceNode>>(new Map());

  const [peaks, setPeaks] = useState<Record<string, Float32Array>>({});
  const [duration, setDuration] = useState(durationHint ?? 0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const playStartTimeRef = useRef(0); // context.currentTime at last (re)play
  const playStartOffsetRef = useRef(0); // playback offset (s) at last (re)play
  const rafRef = useRef<number | null>(null);
  // Most recent rAF-tick time, written by the 60fps loop and read by
  // the 4Hz publishing timer. Sidesteps closure-stale issues.
  const liveTimeRef = useRef(0);
  // Per-lane playhead DOM refs — registered by StemLane on mount and
  // mutated directly from the rAF loop above so the scrubber stays
  // smooth without forcing a React rerender each frame.
  const playheadRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Restore the previous mix on mount. We read synchronously inside
  // the useState initialiser so the very first render already has
  // the saved volumes / mute-solo / master in place — no flash of
  // defaults followed by a snap-to-saved.
  const persisted = useMemo(() => loadPersisted(jobId), [jobId]);

  const [lanes, setLanes] = useState<Record<string, LaneState>>(() => {
    const init: Record<string, LaneState> = {};
    for (const s of stems) {
      init[s.name] =
        persisted?.lanes?.[s.name] ?? { ...DEFAULT_LANE };
    }
    return init;
  });
  const [masterVolume, setMasterVolume] = useState(persisted?.master ?? 1);
  const [mixing, setMixing] = useState(false);
  // Playback rate (0.5..2.0). Applied to every AudioBufferSourceNode
  // so the user can slow a song down for practice. Note: this
  // changes pitch alongside tempo (vinyl-style). Proper pitch-
  // preserved time-stretch needs a phase vocoder — wired separately
  // through ffmpeg's atempo filter when we add HQ rendering.
  const [playbackRate, setPlaybackRate] = useState(1);
  // Mirror rate into a ref so live sources can be retuned without
  // teardown — Web Audio's `playbackRate` is an AudioParam so it
  // accepts a smooth ramp from any thread.
  const playbackRateRef = useRef(playbackRate);
  useEffect(() => {
    playbackRateRef.current = playbackRate;
    sourcesRef.current.forEach((src) => {
      try {
        src.playbackRate.value = playbackRate;
      } catch {
        // node already torn down — next start will pick up the rate.
      }
    });
  }, [playbackRate]);
  // Prefetch the drag plugin module + ghost icon path right after
  // mount. macOS wants `startDrag` called as part of a mouse-down
  // gesture; doing the IPC + dynamic import lazily inside the handler
  // would still work (the event loop yields cleanly) but warming the
  // cache here means the very first drag is also instant.
  useEffect(() => {
    void import('@crabnebula/tauri-plugin-drag').catch(() => {});
    void resolveDragIcon().catch(() => {});
  }, []);

  // Beat-grid overlay default-on when librosa supplied beats. The
  // user can hide it via the transport button for a clean waveform.
  const hasBeats = (beats?.length ?? 0) > 0;
  const [showBeats, setShowBeats] = useState(persisted?.showBeats ?? hasBeats);
  // A-B loop region. `draft` holds the first shift-click while the
  // user picks the second endpoint; `loop` is the active region.
  // Both endpoints are seconds. We mirror `loop` into a ref so the
  // rAF playback tick reads the latest bounds without a dep chain.
  const [loop, setLoop] = useState<{ a: number; b: number } | null>(
    persisted?.loop ?? null,
  );
  const [loopDraft, setLoopDraft] = useState<number | null>(null);
  // Live drag-selection (DAW-style marquee). While the user holds the
  // mouse on a lane, this tracks the [a, b] band that will turn into a
  // committed loop on release. State at the mixer so the band shows
  // across every lane, not only the one that initiated the gesture.
  const [dragSel, setDragSel] = useState<{ a: number; b: number } | null>(null);
  // Visible waveform window in seconds. `null` = full track. Cmd+wheel
  // zooms around the cursor, plain wheel pans. Shared across every
  // lane so the timeline stays in lock-step (GarageBand-style).
  const [view, setView] = useState<{ start: number; end: number } | null>(null);
  // Effective view bounds — falls back to the full track when no zoom
  // is active or duration isn't known yet. Used by every lane and by
  // the loop/drag band remapping.
  const viewStart = view ? Math.max(0, Math.min(duration, view.start)) : 0;
  const viewEnd =
    view ? Math.max(viewStart + 0.05, Math.min(duration, view.end)) : duration;
  const zoomed = view !== null && viewEnd - viewStart < duration - 0.01;
  // Refs mirrored from the bounds above so the rAF playback tick can
  // read the latest view without growing its dep chain (the tick is
  // captured inside startSources and we don't want to tear it down on
  // every zoom step).
  const viewStartRef = useRef(0);
  const viewEndRef = useRef(0);
  useEffect(() => {
    viewStartRef.current = viewStart;
    viewEndRef.current = viewEnd;
  }, [viewStart, viewEnd]);
  const loopRef = useRef<typeof loop>(null);
  useEffect(() => {
    loopRef.current = loop;
  }, [loop]);

  // Persist on change, debounced 300 ms so dragging a slider doesn't
  // hammer localStorage 60×/s. We intentionally don't include
  // `loopDraft` — it's a transient picking step, not user-meaningful
  // state worth preserving across remounts.
  useEffect(() => {
    if (!jobId) return;
    const id = window.setTimeout(() => {
      const snapshot: PersistedMixerState = {
        v: 1,
        master: masterVolume,
        showBeats,
        loop,
        lanes,
      };
      try {
        localStorage.setItem(persistKey(jobId), JSON.stringify(snapshot));
      } catch {
        // Quota exceeded / private mode — best-effort, the next
        // session just opens with defaults.
      }
    }, 300);
    return () => window.clearTimeout(id);
  }, [jobId, masterVolume, showBeats, loop, lanes]);

  const anySolo = useMemo(
    () => Object.values(lanes).some((l) => l.solo),
    [lanes],
  );

  // Effective gain for a lane after mute/solo policy. Pure helper so the
  // mixdown payload and the live Gain.value setter share one source of
  // truth.
  const effectiveGain = useCallback(
    (name: string, master: number = masterVolume) => {
      const l = lanes[name] ?? DEFAULT_LANE;
      const someSolo = Object.values(lanes).some((x) => x.solo);
      const audible = someSolo ? l.solo : !l.muted;
      return audible ? l.volume * master : 0;
    },
    [lanes, masterVolume],
  );

  // ── load + decode every stem once on mount ────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    const ctx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext)();
    ctxRef.current = ctx;
    const master = ctx.createGain();
    master.gain.value = masterVolume;
    master.connect(ctx.destination);
    masterGainRef.current = master;

    const failed: string[] = [];
    let longest = 0;

    /// Load + decode + cache-peaks for one stem in isolation. Returns
    /// the decoded duration so the parent can track the longest stem
    /// for the master timeline. A failure here is appended to `failed`
    /// and the lane is skipped — every other stem keeps loading.
    const loadOne = async (stem: { name: string; path: string }) => {
      try {
        // 1. Try the on-disk peaks cache first. Hits paint the lane
        //    instantly while the (slower) decode runs in the
        //    background, eliminating the "blank waveforms for a
        //    second" jank on every re-open.
        const cached = await readPeaks(stem.path).catch(() => null);
        if (cached && !cancelled) {
          setPeaks((prev) => ({ ...prev, [stem.name]: cached }));
        }
        // 2. Fetch raw bytes through the MediaServer (binary fetch,
        //    no JSON IPC tax). Same trust path AudioPlayer already
        //    uses for the master track.
        const url = await mediaStreamUrl(stem.path);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = await res.arrayBuffer();
        if (cancelled) return;
        const buf = await ctx.decodeAudioData(bytes);
        if (cancelled) return;
        buffersRef.current.set(stem.name, buf);
        if (buf.duration > longest) longest = buf.duration;
        const gain = ctx.createGain();
        gain.gain.value = 1;
        gain.connect(master);
        laneGainRef.current.set(stem.name, gain);
        // 3. If the cache was empty, compute peaks now from the
        //    decoded buffer and persist them so next mount is
        //    instant. Cheap fire-and-forget write.
        if (!cached) {
          const stemPeaks = computePeaks(buf, PEAK_BUCKETS);
          if (!cancelled) {
            setPeaks((prev) => ({ ...prev, [stem.name]: stemPeaks }));
            writePeaks(stem.path, stemPeaks).catch(() => {
              // Stale cache is not fatal; skip the warning so a
              // read-only stems dir doesn't spam the console.
            });
          }
        }
      } catch (e) {
        if (!cancelled) {
          failed.push(
            `${stem.name}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    };

    Promise.all(stems.map(loadOne)).then(() => {
      if (cancelled) return;
      if (failed.length > 0) setLoadError(failed.join(' · '));
      setDuration(longest || durationHint || 0);
      setLoading(false);
    });

    return () => {
      cancelled = true;
      stopSources();
      ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
      masterGainRef.current = null;
      laneGainRef.current.clear();
      buffersRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stems]);

  // Master volume → master gain.
  useEffect(() => {
    if (masterGainRef.current) {
      masterGainRef.current.gain.value = masterVolume;
    }
  }, [masterVolume]);

  // 4Hz clock publisher — the scrubber + time readout don't need 60
  // updates per second, so we cut React work by an order of magnitude.
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setPosition(liveTimeRef.current);
    }, 250);
    return () => window.clearInterval(id);
  }, [playing]);

  // Per-lane mute/solo/volume → live GainNode.
  useEffect(() => {
    for (const stem of stems) {
      const g = laneGainRef.current.get(stem.name);
      if (g) g.gain.value = effectiveGain(stem.name, 1);
      // We split master from lane gain so the master fader doesn't
      // require touching every lane node.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lanes]);

  // ── playback control ──────────────────────────────────────────────
  const stopSources = () => {
    sourcesRef.current.forEach((src) => {
      try {
        src.stop();
      } catch {
        // already stopped
      }
      try {
        src.disconnect();
      } catch {
        // already disconnected
      }
    });
    sourcesRef.current.clear();
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const startSources = useCallback(
    (fromOffset: number) => {
      const ctx = ctxRef.current;
      if (!ctx) return;
      stopSources();
      const now = ctx.currentTime;
      playStartTimeRef.current = now;
      playStartOffsetRef.current = fromOffset;
      for (const stem of stems) {
        const buf = buffersRef.current.get(stem.name);
        const gain = laneGainRef.current.get(stem.name);
        if (!buf || !gain) continue;
        if (fromOffset >= buf.duration) continue;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = playbackRateRef.current;
        src.connect(gain);
        src.start(now, fromOffset);
        sourcesRef.current.set(stem.name, src);
      }
      // 60fps loop drives ONLY DOM transforms (cheap, no React);
      // a separate 250ms timer publishes `position` into React state
      // so the clock + scrubber rerender 4x/s instead of 60x/s.
      // That moved the per-second main-thread cost from ~90 ms (full
      // mixer rerender × 60) to ~6 ms (style writes + 4 rerenders).
      const tick = () => {
        if (!ctxRef.current) return;
        // Audio-domain elapsed time. Web Audio's `playbackRate`
        // multiplies how many sample-seconds advance per real
        // second, so the playhead has to scale real elapsed by the
        // live rate to stay in sync with what the user hears.
        const elapsed =
          (ctxRef.current.currentTime - playStartTimeRef.current) *
          playbackRateRef.current;
        const next = playStartOffsetRef.current + elapsed;
        // Loop wrap — keep restarting from `a` whenever the playhead
        // crosses `b`. We check before the duration-stop branch so a
        // loop region that touches the end of the track keeps looping
        // instead of stopping playback.
        const lp = loopRef.current;
        // Wrap only when the current run started inside the region.
        // Lets the user seek past B with a regular click without the
        // tick yanking them back, while still looping cleanly when
        // playback actually originates inside [a, b].
        if (
          lp &&
          next >= lp.b &&
          playStartOffsetRef.current >= lp.a &&
          playStartOffsetRef.current < lp.b
        ) {
          liveTimeRef.current = lp.a;
          startSources(lp.a);
          return;
        }
        if (next >= duration) {
          setPosition(duration);
          setPlaying(false);
          stopSources();
          playStartOffsetRef.current = duration;
          return;
        }
        liveTimeRef.current = next;
        // Drive the playhead inside the currently visible window —
        // when zoomed in, both bounds shrink, so the same `next`
        // value maps to a different percentage. Clamp 0..100 so a
        // playhead outside the view sits at the nearest edge until
        // it scrolls back in.
        const vS = viewStartRef.current;
        const vE = viewEndRef.current;
        const span = Math.max(0.001, vE - vS);
        // Auto-pan while zoomed in: once the playhead crosses the
        // right ~85% of the visible window, slide the viewport to
        // bring it back to ~15%. Keeps the cursor on screen during
        // playback without yanking the view every frame. Skip when
        // the view already covers the whole track.
        if (span < duration - 0.01) {
          if (next > vS + span * 0.85) {
            setView({
              start: Math.min(duration - span, next - span * 0.15),
              end: Math.min(duration, next - span * 0.15 + span),
            });
          } else if (next < vS) {
            // User seeked backward past the visible window — recenter
            // on the new playhead so it's not stuck off-screen.
            setView({
              start: Math.max(0, next - span * 0.15),
              end: Math.max(span, next - span * 0.15 + span),
            });
          }
        }
        const visible = next >= vS && next <= vE;
        const pct =
          duration > 0
            ? `${Math.max(0, Math.min(100, ((next - vS) / span) * 100))}%`
            : '0%';
        playheadRefs.current.forEach((el) => {
          if (el) {
            el.style.left = pct;
            el.style.opacity = visible ? '1' : '0';
          }
        });
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    },
    [stems, duration],
  );

  const play = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx || loading) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const from = position >= duration ? 0 : position;
    setPlaying(true);
    startSources(from);
  }, [duration, loading, position, startSources]);

  const pause = useCallback(() => {
    if (!ctxRef.current) return;
    const elapsed =
      (ctxRef.current.currentTime - playStartTimeRef.current) *
      playbackRateRef.current;
    const current = playStartOffsetRef.current + elapsed;
    stopSources();
    setPosition(Math.min(duration, Math.max(0, current)));
    setPlaying(false);
  }, [duration]);

  /// Place an A or B marker, or clear an active loop. The flow:
  ///   1st shift-click → record the timestamp as draft A.
  ///   2nd shift-click → close the region (A = min, B = max).
  ///   shift-click while a loop is active → clear it.
  /// Picking the second endpoint within 50 ms of the first is treated
  /// as a clear so a double-tap aborts an accidental first click.
  const setLoopPoint = useCallback(
    (t: number) => {
      const clamped = Math.max(0, Math.min(duration, t));
      if (loop) {
        setLoop(null);
        setLoopDraft(null);
        return;
      }
      if (loopDraft === null) {
        setLoopDraft(clamped);
        return;
      }
      const a = Math.min(loopDraft, clamped);
      const b = Math.max(loopDraft, clamped);
      if (b - a < 0.05) {
        setLoopDraft(null);
        return;
      }
      setLoop({ a, b });
      setLoopDraft(null);
    },
    [duration, loop, loopDraft],
  );

  const clearLoop = useCallback(() => {
    setLoop(null);
    setLoopDraft(null);
    setDragSel(null);
  }, []);

  /// Zoom centred on `pivotT` (seconds). Factor < 1 zooms in,
  /// > 1 zooms out. Clamps to a 200 ms minimum visible window so
  /// the canvas never collapses to a single bucket. Mouse / trackpad
  /// callers pass `pivotT` = cursor time so the section under the
  /// pointer stays visually pinned during the zoom — the GarageBand
  /// behaviour users expect.
  const zoomAt = useCallback(
    (pivotT: number, factor: number) => {
      if (!duration) return;
      setView((prev) => {
        const curStart = prev?.start ?? 0;
        const curEnd = prev?.end ?? duration;
        const curSpan = curEnd - curStart;
        const nextSpan = Math.min(duration, Math.max(0.2, curSpan * factor));
        if (Math.abs(nextSpan - duration) < 0.05) return null;
        // Anchor the visible-fraction position of the pivot point so
        // the time under the cursor stays put.
        const pivotFrac = curSpan > 0 ? (pivotT - curStart) / curSpan : 0.5;
        let start = pivotT - nextSpan * pivotFrac;
        let end = start + nextSpan;
        if (start < 0) {
          start = 0;
          end = nextSpan;
        } else if (end > duration) {
          end = duration;
          start = duration - nextSpan;
        }
        return { start, end };
      });
    },
    [duration],
  );

  /// Horizontal pan by `deltaT` seconds. Used by plain wheel scroll
  /// when the view is zoomed in. No-op at full zoom (nothing to
  /// scroll past).
  const panBy = useCallback(
    (deltaT: number) => {
      if (!duration) return;
      setView((prev) => {
        if (!prev) return prev;
        const span = prev.end - prev.start;
        let start = prev.start + deltaT;
        let end = start + span;
        if (start < 0) {
          start = 0;
          end = span;
        } else if (end > duration) {
          end = duration;
          start = duration - span;
        }
        return { start, end };
      });
    },
    [duration],
  );

  const resetZoom = useCallback(() => setView(null), []);

  /// Commit a marquee drag as a loop region. Tiny ranges (< 80 ms) are
  /// almost certainly accidental — treat them as a no-op rather than
  /// strapping the playhead to a single point and yanking it back
  /// every frame. When BPM-derived beats are available we snap both
  /// endpoints to the nearest beat — practising a 4-bar loop is way
  /// easier when the start/end already align with the bar grid.
  const snapToBeat = useCallback(
    (t: number): number => {
      if (!beats || beats.length === 0) return t;
      // Binary search for the nearest beat — beats are sorted by
      // construction (librosa emits ascending times).
      let lo = 0;
      let hi = beats.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (beats[mid] < t) lo = mid + 1;
        else hi = mid;
      }
      const after = beats[lo];
      const before = lo > 0 ? beats[lo - 1] : after;
      return Math.abs(after - t) < Math.abs(t - before) ? after : before;
    },
    [beats],
  );

  const setLoopRange = useCallback(
    (a: number, b: number) => {
      const lo = Math.max(0, Math.min(a, b));
      const hi = Math.min(duration, Math.max(a, b));
      setDragSel(null);
      if (hi - lo < 0.08) return;
      const snappedLo = snapToBeat(lo);
      const snappedHi = snapToBeat(hi);
      // Fall back to raw bounds when snapping collapses the region
      // (e.g. both ends snap to the same beat on a very short drag).
      const finalLo = snappedHi - snappedLo >= 0.08 ? snappedLo : lo;
      const finalHi = snappedHi - snappedLo >= 0.08 ? snappedHi : hi;
      setLoop({ a: finalLo, b: finalHi });
      setLoopDraft(null);
    },
    [duration, snapToBeat],
  );

  const seek = useCallback(
    (t: number) => {
      const clamped = Math.max(0, Math.min(duration, t));
      setPosition(clamped);
      if (playing) startSources(clamped);
      else playStartOffsetRef.current = clamped;
    },
    [duration, playing, startSources],
  );

  // Space / left / right keyboard control while the mixer is focused.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const active = document.activeElement;
      if (active && active !== document.body && !root.contains(active)) return;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement
      )
        return;
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (playing) pause();
        else play();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        seek(position - (e.shiftKey ? 10 : 5));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        seek(position + (e.shiftKey ? 10 : 5));
      } else if (e.key === 'l' || e.key === 'L') {
        // L mirrors shift+click on the current position — quickly
        // stage A then B without reaching for the lane with the mouse.
        e.preventDefault();
        setLoopPoint(position);
      } else if (e.key === 'Escape' && (loop || loopDraft !== null)) {
        e.preventDefault();
        clearLoop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [play, pause, playing, position, seek, setLoopPoint, clearLoop, loop, loopDraft]);

  // ── lane controls ────────────────────────────────────────────────
  const setLane = (name: string, patch: Partial<LaneState>) =>
    setLanes((prev) => ({
      ...prev,
      [name]: { ...(prev[name] ?? DEFAULT_LANE), ...patch },
    }));

  const toggleMute = (name: string) =>
    setLane(name, { muted: !(lanes[name]?.muted ?? false) });

  // DAW-style solo: any number of lanes can be solo'd simultaneously.
  // When any solo is active, only solo'd lanes are audible (see
  // effectiveGain — solo overrides the lane's own mute flag too,
  // matching Logic / Ableton / Pro Tools).
  const toggleSolo = (name: string) =>
    setLane(name, { solo: !(lanes[name]?.solo ?? false) });

  // ── mixdown ──────────────────────────────────────────────────────
  const handleMixdown = async () => {
    const active = stems
      .map((s) => ({
        name: s.name,
        path: s.path,
        gain: effectiveGain(s.name, masterVolume),
      }))
      .filter((s) => s.gain > 0);
    if (active.length === 0) {
      toast({
        title: 'Nothing to mix',
        description: 'Every stem is muted — un-mute or un-solo first.',
        variant: 'error',
      });
      return;
    }
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_popup_auto_hide', { enabled: false }).catch(() => {});
    let target: string | null = null;
    try {
      const picked = await saveDialog({
        title: 'Save mixdown',
        defaultPath: 'mixdown.wav',
        filters: [{ name: 'WAV audio', extensions: ['wav'] }],
      });
      if (typeof picked === 'string') target = picked;
    } finally {
      await invoke('set_popup_auto_hide', { enabled: true }).catch(() => {});
    }
    if (!target) return;
    setMixing(true);
    try {
      const out = await mixdown(target, active);
      toast({ title: 'Mixdown ready', description: out, variant: 'success' });
      revealFile(out).catch(() => {});
    } catch (e) {
      toast({
        title: 'Mixdown failed',
        description: String(e),
        variant: 'error',
      });
    } finally {
      setMixing(false);
    }
  };

  return (
    <div
      ref={rootRef}
      className="rounded-md border [border-color:var(--hairline)] overflow-hidden"
      style={{ background: 'rgba(255,255,255,0.02)' }}
      data-testid="stem-mixer"
    >
      <Transport
        playing={playing}
        position={position}
        duration={duration}
        masterVolume={masterVolume}
        onPlay={play}
        onPause={pause}
        onSeek={seek}
        onMasterVolume={setMasterVolume}
        onMixdown={handleMixdown}
        mixing={mixing}
        loading={loading}
        hasBeats={hasBeats}
        showBeats={showBeats}
        onToggleBeats={() => setShowBeats((v) => !v)}
        loop={loop}
        loopDraft={loopDraft}
        onClearLoop={clearLoop}
        playbackRate={playbackRate}
        onPlaybackRate={setPlaybackRate}
        bpm={bpm}
      />
      {loadError && (
        <div className="px-3 py-2 text-meta" style={{ color: '#f87171' }}>
          {loadError}
        </div>
      )}
      <ChordRibbon
        chords={chords}
        duration={duration}
        viewStart={viewStart}
        viewEnd={viewEnd}
        onSeek={seek}
        onDetect={onDetectChords}
        busy={!!chordsBusy}
      />
      <ViewportBar
        duration={duration}
        viewStart={viewStart}
        viewEnd={viewEnd}
        onPan={panBy}
        onReset={resetZoom}
        zoomed={zoomed}
      />
      <ul className="divide-y [&>li]:[border-color:var(--hairline)]">
        {stems.map((stem) => (
          <StemLane
            key={stem.name}
            name={stem.name}
            path={stem.path}
            peaks={peaks[stem.name]}
            duration={duration}
            position={position}
            lane={lanes[stem.name] ?? DEFAULT_LANE}
            dimmed={anySolo && !(lanes[stem.name]?.solo ?? false)}
            midiBusy={midiBusy === stem.name}
            anyMidiBusy={midiBusy !== null}
            registerPlayhead={(el) => {
              if (el) playheadRefs.current.set(stem.name, el);
              else playheadRefs.current.delete(stem.name);
            }}
            onMute={() => toggleMute(stem.name)}
            onSolo={() => toggleSolo(stem.name)}
            onVolume={(v) => setLane(stem.name, { volume: v })}
            onSeek={seek}
            onReveal={() => onReveal(stem.path)}
            onCopyPath={() => onCopyPath(stem.path)}
            onCopyEmbed={() => onCopyEmbed(stem.path, stem.name)}
            onExtractMidi={() => onExtractMidi(stem.path, stem.name)}
            onDelete={() => onDelete(stem.path, stem.name)}
            beats={showBeats ? beats : undefined}
            loop={loop}
            loopDraft={loopDraft}
            onSetLoopPoint={setLoopPoint}
            dragSel={dragSel}
            onDragStart={(t) => setDragSel({ a: t, b: t })}
            onDragUpdate={(t) =>
              setDragSel((prev) => (prev ? { ...prev, b: t } : null))
            }
            onSetLoopRange={setLoopRange}
            onDragCancel={() => setDragSel(null)}
            viewStart={viewStart}
            viewEnd={viewEnd}
            onZoom={zoomAt}
            onPan={panBy}
          />
        ))}
      </ul>
    </div>
  );
}

// ─── transport bar ─────────────────────────────────────────────────────

interface TransportProps {
  playing: boolean;
  position: number;
  duration: number;
  masterVolume: number;
  loading: boolean;
  mixing: boolean;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (t: number) => void;
  onMasterVolume: (v: number) => void;
  onMixdown: () => void;
  hasBeats: boolean;
  showBeats: boolean;
  onToggleBeats: () => void;
  loop: { a: number; b: number } | null;
  loopDraft: number | null;
  onClearLoop: () => void;
  playbackRate: number;
  onPlaybackRate: (v: number) => void;
  bpm?: number;
}

function Transport({
  playing,
  position,
  duration,
  masterVolume,
  loading,
  mixing,
  onPlay,
  onPause,
  onSeek,
  onMasterVolume,
  onMixdown,
  hasBeats,
  showBeats,
  onToggleBeats,
  loop,
  loopDraft,
  onClearLoop,
  playbackRate,
  onPlaybackRate,
  bpm,
}: TransportProps) {
  return (
    <div className="stash-stem-transport">
      <TransportButton
        size="md"
        active={playing}
        title={playing ? 'Pause (Space)' : 'Play (Space)'}
        onClick={() => (playing ? onPause() : onPlay())}
        disabled={loading || duration === 0}
        data-testid="mixer-play"
      >
        {playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
      </TransportButton>
      <span className="text-meta font-mono tabular-nums t-secondary shrink-0 select-none">
        {formatClock(position)}
        <span className="opacity-40 px-1">/</span>
        {formatClock(duration)}
      </span>
      {bpm != null && Number.isFinite(bpm) && (
        <span
          className="text-meta font-mono tabular-nums shrink-0 select-none rounded px-1.5 py-0.5"
          title={`Tempo · ${bpm.toFixed(1)} BPM (librosa beat track on drums stem)`}
          style={{
            background: 'rgba(255,255,255,0.04)',
            color: 'var(--text-secondary)',
            border: '1px solid var(--hairline)',
          }}
        >
          {bpm.toFixed(0)}
          <span className="opacity-50 ml-0.5">bpm</span>
        </span>
      )}
      <div className="flex-1 min-w-0">
        <RangeSlider
          value={Math.min(position, duration || 0.01)}
          onChange={onSeek}
          min={0}
          max={Math.max(0.01, duration)}
          step={0.01}
          label="Seek"
          disabled={loading}
          className="stash-stem-seek"
        />
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-meta opacity-50 tracking-wider">VOL</span>
        <div className="w-24">
          <RangeSlider
            value={masterVolume}
            onChange={onMasterVolume}
            min={0}
            max={1.5}
            step={0.01}
            label="Master volume"
          />
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          // Cycle 1.0 → 0.75 → 0.5 → 1.25 → 1.0 — the four ratios
          // worth practicing at. Shift+click resets straight to 1.0.
          const steps = [1, 0.75, 0.5, 1.25];
          const i = steps.findIndex((s) => Math.abs(s - playbackRate) < 0.01);
          onPlaybackRate(steps[(i + 1) % steps.length]);
        }}
        onDoubleClick={() => onPlaybackRate(1)}
        title={`Speed: ${playbackRate.toFixed(2)}× — click to cycle, double-click to reset (changes pitch too)`}
        className="text-meta font-mono tabular-nums shrink-0 select-none rounded px-1.5 py-0.5 transition-colors"
        style={{
          background:
            playbackRate === 1 ? 'transparent' : 'rgba(var(--stash-accent-rgb), 0.12)',
          color:
            playbackRate === 1 ? 'var(--text-secondary)' : 'rgb(var(--stash-accent-rgb))',
          border:
            playbackRate === 1
              ? '1px solid var(--hairline)'
              : '1px solid rgba(var(--stash-accent-rgb), 0.32)',
        }}
      >
        {playbackRate.toFixed(2)}×
      </button>
      {hasBeats && (
        <IconButton
          title={showBeats ? 'Hide beat grid' : 'Show beat grid'}
          onClick={onToggleBeats}
          active={showBeats}
        >
          <BeatGridIcon size={12} />
        </IconButton>
      )}
      {(loop || loopDraft !== null) && (
        <button
          type="button"
          onClick={onClearLoop}
          title="Clear loop region"
          className="text-meta font-mono tabular-nums shrink-0 select-none rounded px-1.5 py-0.5 transition-colors"
          style={{
            background: 'rgba(var(--stash-accent-rgb), 0.12)',
            color: 'rgb(var(--stash-accent-rgb))',
            border: '1px solid rgba(var(--stash-accent-rgb), 0.32)',
          }}
        >
          {loop
            ? `${formatClock(loop.a)} ↔ ${formatClock(loop.b)} ×`
            : `A ${formatClock(loopDraft ?? 0)} · pick B…`}
        </button>
      )}
      <Button
        size="xs"
        variant="soft"
        tone="accent"
        loading={mixing}
        disabled={loading}
        onClick={onMixdown}
      >
        {mixing ? 'Mixing…' : 'Mix down'}
      </Button>
    </div>
  );
}

/// Slim scrollbar that surfaces the zoomed-in viewport against the
/// full track. Shows the entire duration as a track and the visible
/// `[viewStart, viewEnd]` as a draggable thumb. Hidden when zoom is
/// inactive — at full zoom there's nothing to scroll past. Doubles
/// as a "reset zoom" affordance when the user double-clicks it.
function ViewportBar({
  duration,
  viewStart,
  viewEnd,
  onPan,
  onReset,
  zoomed,
}: {
  duration: number;
  viewStart: number;
  viewEnd: number;
  onPan: (deltaT: number) => void;
  onReset: () => void;
  zoomed: boolean;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startView: number } | null>(null);

  if (!zoomed || duration <= 0) return null;
  const left = (viewStart / duration) * 100;
  const width = ((viewEnd - viewStart) / duration) * 100;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const thumbLeftPx = (viewStart / duration) * rect.width;
    const thumbWidthPx = ((viewEnd - viewStart) / duration) * rect.width;
    const localX = e.clientX - rect.left;
    // Click outside the thumb → snap it so the click point becomes
    // the thumb centre (matches macOS scrollbar behaviour).
    if (localX < thumbLeftPx || localX > thumbLeftPx + thumbWidthPx) {
      const target = (localX / rect.width) * duration - (viewEnd - viewStart) / 2;
      onPan(target - viewStart);
    }
    dragRef.current = { startX: e.clientX, startView: viewStart };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const dx = e.clientX - drag.startX;
    const dt = (dx / rect.width) * duration;
    const targetStart = drag.startView + dt;
    onPan(targetStart - viewStart);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // capture already released
    }
  };

  return (
    <div
      ref={trackRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onReset}
      className="relative h-2 cursor-grab active:cursor-grabbing select-none border-b [border-color:var(--hairline)]"
      style={{ background: 'rgba(255,255,255,0.04)', touchAction: 'none' }}
      title="Scroll the zoomed view · double-click resets zoom"
    >
      <div
        className="absolute top-0 bottom-0 rounded-sm pointer-events-none"
        style={{
          left: `${left}%`,
          width: `${Math.max(2, width)}%`,
          background: 'rgba(var(--stash-accent-rgb), 0.55)',
          boxShadow:
            'inset 1px 0 0 rgba(var(--stash-accent-rgb), 0.95), inset -1px 0 0 rgba(var(--stash-accent-rgb), 0.95)',
        }}
      />
    </div>
  );
}

/// Accent-only ribbon — same monochrome palette the rest of Stash
/// uses (compare Pomodoro's chip / progress fills). We vary opacity
/// per row index so neighbouring chord boxes are still visually
/// separable even if both happen to be the same chord; the label
/// text inside is what tells the user which chord it is.
function chordTint(idx: number, minor: boolean): string {
  // Three opacity steps cycled by index produce a calm "siding"
  // rhythm. Minor chords drop a touch dimmer so a Cmaj-Cm flip
  // reads as a tonal shift, not two identical tiles.
  const steps = [0.18, 0.30, 0.22];
  const a = steps[idx % steps.length] * (minor ? 0.75 : 1);
  return `rgba(var(--stash-accent-rgb), ${a.toFixed(3)})`;
}

/// Thin horizontal track above the stem lanes that renders detected
/// chord segments. Segments are clickable — clicking seeks to the
/// segment start, which is the practice-friendly way to jump straight
/// to "the F#m bit". When no chords are cached yet we surface a
/// "Detect chords" CTA so the user knows the feature is available.
function ChordRibbon({
  chords,
  duration,
  viewStart,
  viewEnd,
  onSeek,
  onDetect,
  busy,
}: {
  chords: ChordSegment[] | undefined;
  duration: number;
  viewStart: number;
  viewEnd: number;
  onSeek: (t: number) => void;
  onDetect: (() => void) | undefined;
  busy: boolean;
}) {
  const ribbonRef = useRef<HTMLDivElement | null>(null);
  const [ribbonWidth, setRibbonWidth] = useState(0);
  useEffect(() => {
    const el = ribbonRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setRibbonWidth(entry.contentRect.width);
    });
    ro.observe(el);
    setRibbonWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, [chords]);

  if (chords && chords.length === 0 && !busy) return null;
  if (!chords) {
    return (
      <div className="flex items-center justify-end px-3 py-1 border-b [border-color:var(--hairline)]">
        <button
          type="button"
          onClick={onDetect}
          disabled={busy || !onDetect}
          className="text-meta px-2 py-0.5 rounded transition-colors disabled:opacity-50"
          style={{
            background: 'rgba(var(--stash-accent-rgb), 0.10)',
            color: 'rgb(var(--stash-accent-rgb))',
            border: '1px solid rgba(var(--stash-accent-rgb), 0.30)',
          }}
        >
          {busy ? 'Detecting chords…' : 'Detect chords'}
        </button>
      </div>
    );
  }
  if (duration <= 0) return null;

  void ribbonWidth; // tracked only so resize-induced rerenders happen
  const span = Math.max(0.001, viewEnd - viewStart);
  // Pre-filter to the visible window so we don't iterate hundreds of
  // off-screen segments while zoomed in.
  const visible = chords.filter((c) => c.end >= viewStart && c.start <= viewEnd);

  return (
    <div
      ref={ribbonRef}
      className="relative h-8 border-b [border-color:var(--hairline)] select-none"
      style={{ background: 'rgba(0,0,0,0.25)' }}
      aria-label="Chord track"
    >
      {visible.map((c, i) => {
        const lo = Math.max(viewStart, c.start);
        const hi = Math.min(viewEnd, c.end);
        const left = ((lo - viewStart) / span) * 100;
        const width = ((hi - lo) / span) * 100;
        const minor = c.label.endsWith('m');
        const tint = chordTint(i, minor);
        return (
          <button
            key={`${i}-${c.start}`}
            type="button"
            onClick={() => onSeek(c.start)}
            title={`${c.label} · ${c.start.toFixed(1)}s → ${c.end.toFixed(1)}s`}
            className="absolute top-0 bottom-0 font-mono tabular-nums hover:brightness-125 transition flex items-center justify-center"
            style={{
              left: `${left}%`,
              width: `${Math.max(0.3, width)}%`,
              background: tint,
              color: 'rgb(var(--stash-accent-rgb))',
              borderRight: '1px solid rgba(255,255,255,0.06)',
              fontSize: 13,
              fontWeight: 600,
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              padding: '0 4px',
              letterSpacing: -0.2,
            }}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

/// Tiny grid glyph — three short vertical bars; communicates "beat
/// grid" without competing with the rest of the transport row.
function BeatGridIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
    >
      <line x1="2.5" y1="2" x2="2.5" y2="10" />
      <line x1="6" y1="2" x2="6" y2="10" />
      <line x1="9.5" y1="2" x2="9.5" y2="10" />
    </svg>
  );
}

// ─── per-stem lane ─────────────────────────────────────────────────────

interface LaneProps {
  name: string;
  path: string;
  peaks: Float32Array | undefined;
  duration: number;
  position: number;
  lane: LaneState;
  dimmed: boolean;
  midiBusy: boolean;
  anyMidiBusy: boolean;
  /// Called with the playhead `<div>` once on mount and `null` on
  /// unmount. The mixer writes `style.left` directly into this node
  /// from its 60fps rAF loop so the scrubber stays buttery without
  /// forcing a React rerender on every frame.
  registerPlayhead: (el: HTMLDivElement | null) => void;
  onMute: () => void;
  onSolo: () => void;
  onVolume: (v: number) => void;
  onSeek: (t: number) => void;
  onReveal: () => void;
  onCopyPath: () => void;
  onCopyEmbed: () => void;
  onExtractMidi: () => void;
  onDelete: () => void;
  /// Optional beat times (seconds) rendered as faint vertical lines
  /// over the waveform; passing `undefined` keeps the canvas clean.
  /// Lane redraws on toggle because `beats` enters the layout deps.
  beats?: number[];
  /// Active A-B loop region (seconds). When set, the lane renders a
  /// translucent band between the endpoints and the transport tick
  /// wraps playback back to `a` whenever it crosses `b`.
  loop: { a: number; b: number } | null;
  /// First endpoint of a pending loop (shift-click in flight). Drawn
  /// as a single dashed vertical line so the user can see what's
  /// staged before they commit B with the next click.
  loopDraft: number | null;
  /// shift+click on the lane forwards here so the mixer can stage
  /// the next A/B endpoint or clear an active region.
  onSetLoopPoint: (t: number) => void;
  /// Live marquee selection from the lane currently being dragged.
  /// All lanes render the same band so the user gets DAW-style
  /// cross-track visual feedback.
  dragSel: { a: number; b: number } | null;
  onDragStart: (t: number) => void;
  onDragUpdate: (t: number) => void;
  onDragCancel: () => void;
  onSetLoopRange: (a: number, b: number) => void;
  /// Visible-window bounds in seconds. Equal to [0, duration] when no
  /// zoom is active. The lane uses these to slice the peaks array
  /// and to remap loop / dragSel / beats / playhead from track-time
  /// to view-relative percentages.
  viewStart: number;
  viewEnd: number;
  /// Zoom around a time pivot (factor < 1 = in, > 1 = out).
  /// Triggered from Cmd/Ctrl + wheel inside the waveform.
  onZoom: (pivotT: number, factor: number) => void;
  /// Horizontal pan by `deltaT` seconds. Plain wheel scroll when the
  /// view is zoomed in.
  onPan: (deltaT: number) => void;
}

function StemLane({
  name,
  path,
  peaks,
  duration,
  position,
  lane,
  dimmed,
  midiBusy,
  anyMidiBusy,
  registerPlayhead,
  onMute,
  onSolo,
  onVolume,
  onSeek,
  onReveal,
  onCopyPath,
  onCopyEmbed,
  onExtractMidi,
  onDelete,
  beats,
  loop,
  loopDraft,
  onSetLoopPoint,
  dragSel,
  onDragStart,
  onDragUpdate,
  onDragCancel,
  onSetLoopRange,
  viewStart,
  viewEnd,
  onZoom,
  onPan,
}: LaneProps) {
  // path is forwarded for callers that prefer absolute paths in tooltips.
  void path;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const rgb = stemColor(name);
  const label = STEM_LABELS[name] ?? name;

  // Live width tracker so the canvas redraws when the popup is
  // resized horizontally (or when the user reflows the tabs). We
  // observe the wrap div directly because the canvas itself is
  // pixel-buffer sized and only changes when we explicitly redraw.
  const [wrapWidth, setWrapWidth] = useState(0);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = e.contentRect.width;
        // Skip jitter from sub-pixel layout — only redraw when the
        // integer width actually changes.
        setWrapWidth((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
      }
    });
    ro.observe(wrap);
    setWrapWidth(wrap.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || !peaks) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = wrap.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const midY = canvas.height / 2;
    // Slice the peaks to the visible window. Peaks are uniformly
    // distributed across the source duration, so we just map start /
    // end time → bucket index. When zoomed in we draw fewer buckets
    // across the same canvas width, which is exactly the look the
    // user wants (zoomed-in waveform with thicker bars).
    const total = peaks.length;
    const span = Math.max(0.001, viewEnd - viewStart);
    const startIdx = Math.max(
      0,
      Math.floor((viewStart / Math.max(0.001, duration)) * total),
    );
    const endIdx = Math.min(
      total,
      Math.ceil((viewEnd / Math.max(0.001, duration)) * total),
    );
    const visible = Math.max(1, endIdx - startIdx);
    const barWidth = canvas.width / visible;
    ctx.fillStyle = `rgba(${rgb}, ${lane.muted || dimmed ? 0.18 : 0.85})`;
    for (let i = 0; i < visible; i++) {
      const h = Math.max(1, peaks[startIdx + i] * midY * 1.6);
      const x = i * barWidth;
      ctx.fillRect(x, midY - h, Math.max(1, barWidth - 0.5), h * 2);
    }
    // Beat grid — same projection logic but in track time, not in
    // bucket index, so a zoomed view shows beats spread out across
    // the full canvas width.
    if (beats && beats.length > 0 && duration > 0) {
      ctx.lineWidth = Math.max(1, dpr);
      for (let i = 0; i < beats.length; i++) {
        const t = beats[i];
        if (t < viewStart || t > viewEnd) continue;
        const x = ((t - viewStart) / span) * canvas.width;
        const downbeat = i % 4 === 0;
        ctx.strokeStyle = `rgba(255, 255, 255, ${downbeat ? 0.32 : 0.14})`;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }
    }
  }, [peaks, lane.muted, dimmed, rgb, beats, duration, viewStart, viewEnd, wrapWidth]);

  // Marquee-select state for this lane. We hold the pointer-down
  // origin in a ref so pointermove can decide whether a click is
  // really a drag (threshold: 4 px). `dragging` flips true after the
  // user crosses that threshold so on pointerup we know to commit a
  // loop range instead of seeking to the click point.
  const dragOrigin = useRef<{ x: number; t: number } | null>(null);
  const dragging = useRef(false);

  const xToTime = (clientX: number): number | null => {
    const wrap = wrapRef.current;
    if (!wrap || !duration) return null;
    const rect = wrap.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    const t = viewStart + ratio * (viewEnd - viewStart);
    return Math.max(0, Math.min(duration, t));
  };

  // Wheel: Cmd/Ctrl = zoom around cursor (GarageBand-style), plain
  // wheel = horizontal pan inside the zoomed window. React's
  // synthetic `onWheel` attaches passively in modern browsers, so
  // `preventDefault` is silently dropped — the popup keeps scrolling
  // behind us. Bind a native non-passive listener instead so the
  // page actually stops when we handle the event.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (e: WheelEvent) => {
      if (!duration) return;
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        const rect = wrap.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / rect.width;
        const t = Math.max(0, Math.min(duration, viewStart + ratio * (viewEnd - viewStart)));
        const factor = Math.pow(1.0015, e.deltaY);
        onZoom(t, factor);
        return;
      }
      if (viewEnd - viewStart < duration - 0.01) {
        e.preventDefault();
        e.stopPropagation();
        const span = viewEnd - viewStart;
        const px = wrap.getBoundingClientRect().width || 1;
        onPan((e.deltaX !== 0 ? e.deltaX : e.deltaY) * (span / px));
      }
    };
    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => wrap.removeEventListener('wheel', onWheel);
  }, [duration, viewStart, viewEnd, onZoom, onPan]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const t = xToTime(e.clientX);
    if (t === null) return;
    // shift+click keeps the legacy A/B picker available for users who
    // prefer keyboard-style point-picking over a drag.
    if (e.shiftKey) {
      onSetLoopPoint(t);
      return;
    }
    dragOrigin.current = { x: e.clientX, t };
    dragging.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const origin = dragOrigin.current;
    if (!origin) return;
    if (!dragging.current) {
      if (Math.abs(e.clientX - origin.x) < 4) return;
      dragging.current = true;
      onDragStart(origin.t);
    }
    const t = xToTime(e.clientX);
    if (t !== null) onDragUpdate(t);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const origin = dragOrigin.current;
    dragOrigin.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // capture already released
    }
    if (!origin) return;
    if (!dragging.current) {
      // Plain click → seek to the click point.
      onSeek(origin.t);
      return;
    }
    dragging.current = false;
    const end = xToTime(e.clientX) ?? origin.t;
    onSetLoopRange(origin.t, end);
  };

  const onPointerCancel = () => {
    dragOrigin.current = null;
    dragging.current = false;
    onDragCancel();
  };

  // Remap track-time into the visible-window percentage so every
  // overlay (playhead, loop, drag band) stays in sync with the
  // zoomed waveform. Returns null when the time is outside the
  // window — callers hide the overlay in that case.
  const viewSpan = Math.max(0.001, viewEnd - viewStart);
  const tToPct = (t: number): number => ((t - viewStart) / viewSpan) * 100;
  const playheadLeft =
    duration > 0
      ? `${Math.max(0, Math.min(100, tToPct(position)))}%`
      : '0%';
  const playheadVisible = position >= viewStart && position <= viewEnd;

  return (
    <li
      className="group flex items-stretch gap-2 px-2 py-1.5 hover:[background:rgba(255,255,255,0.02)]"
      data-testid={`mixer-lane-${name}`}
    >
      <div className="flex flex-col gap-1 w-28 shrink-0 justify-between">
        <div
          className="flex items-center gap-1.5 min-w-0 cursor-grab active:cursor-grabbing select-none"
          onMouseDown={(e) => {
            // Native drag-out to Finder / Logic / Ableton. macOS
            // takes over the cursor the moment startDrag fires, so
            // we kick it off straight from the mouse-down event —
            // any other handler on this row stops listening as the
            // drag session begins.
            if (e.button !== 0) return;
            e.preventDefault();
            void startStemDrag(path);
          }}
          title={`Drag ${label} to Finder / DAW`}
        >
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ background: `rgb(${rgb})` }}
            aria-hidden
          />
          <span
            className="text-meta t-secondary font-medium truncate"
          >
            {label}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <TrackToggle
            tone="mute"
            active={lane.muted}
            onClick={onMute}
            title="Mute"
            data-testid={`mixer-lane-${name}-mute`}
          >
            M
          </TrackToggle>
          <TrackToggle
            tone="solo"
            colorRgb={rgb}
            active={lane.solo}
            onClick={onSolo}
            title="Solo"
            data-testid={`mixer-lane-${name}-solo`}
          >
            S
          </TrackToggle>
          <div className="flex-1 min-w-0">
            <RangeSlider
              value={lane.volume}
              onChange={onVolume}
              min={0}
              max={1.5}
              step={0.01}
              label={`${label} volume`}
              colorRgb={rgb}
              data-testid={`mixer-lane-${name}-vol`}
            />
          </div>
        </div>
      </div>
      {/* Hover-revealed per-stem actions. Sits to the right of the lane
          header so clicks don't collide with mute/solo. */}
      <div
        className="flex items-center gap-0.5 shrink-0 self-start opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
        style={{ marginTop: 1 }}
        data-testid={`mixer-lane-${name}-actions`}
      >
        <IconButton title="Show in Finder" onClick={onReveal}>
          <ExternalIcon size={12} />
        </IconButton>
        <IconButton title="Copy as markdown for Notes" onClick={onCopyEmbed}>
          <NoteIcon size={12} />
        </IconButton>
        <IconButton title="Copy file path" onClick={onCopyPath}>
          <CopyIcon size={12} />
        </IconButton>
        <IconButton
          title={
            midiBusy
              ? 'Extracting MIDI…'
              : 'Extract MIDI (basic-pitch) — drag to Guitar Pro'
          }
          onClick={onExtractMidi}
          disabled={anyMidiBusy}
        >
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: 0.5,
              lineHeight: 1,
              opacity: midiBusy ? 0.5 : 1,
            }}
          >
            MIDI
          </span>
        </IconButton>
        <IconButton title="Delete stem (removes file)" onClick={onDelete}>
          <TrashIcon size={12} />
        </IconButton>
      </div>
      <div
        ref={wrapRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        className="relative flex-1 h-12 rounded-sm cursor-crosshair select-none"
        style={{
          background: `rgba(${rgb}, 0.05)`,
          boxShadow: `inset 0 0 0 1px rgba(${rgb}, 0.18)`,
          touchAction: 'none',
        }}
      >
        <canvas ref={canvasRef} className="block w-full h-full pointer-events-none" />
        {dragSel && duration > 0 && (() => {
          // Clip the in-progress band to the visible window — if the
          // user started a drag while zoomed in and panned past it,
          // we don't want a stray strip rendered off-grid.
          const lo = Math.max(viewStart, Math.min(dragSel.a, dragSel.b));
          const hi = Math.min(viewEnd, Math.max(dragSel.a, dragSel.b));
          if (hi <= lo) return null;
          return (
            <div
              aria-hidden
              className="absolute top-0 bottom-0 pointer-events-none"
              style={{
                left: `${tToPct(lo)}%`,
                width: `${tToPct(hi) - tToPct(lo)}%`,
                background: `rgba(${rgb}, 0.28)`,
                boxShadow: `inset 1px 0 0 rgba(${rgb}, 0.9), inset -1px 0 0 rgba(${rgb}, 0.9)`,
              }}
            />
          );
        })()}
        {loop && duration > 0 && (() => {
          const lo = Math.max(viewStart, loop.a);
          const hi = Math.min(viewEnd, loop.b);
          if (hi <= lo) return null;
          return (
            <div
              aria-hidden
              className="absolute top-0 bottom-0 pointer-events-none"
              style={{
                left: `${tToPct(lo)}%`,
                width: `${tToPct(hi) - tToPct(lo)}%`,
                background: `rgba(${rgb}, 0.18)`,
                boxShadow: `inset 1px 0 0 rgba(${rgb}, 0.8), inset -1px 0 0 rgba(${rgb}, 0.8)`,
              }}
            />
          );
        })()}
        {loopDraft !== null &&
          duration > 0 &&
          loopDraft >= viewStart &&
          loopDraft <= viewEnd && (
            <div
              aria-hidden
              className="absolute top-0 bottom-0 pointer-events-none"
              style={{
                left: `${tToPct(loopDraft)}%`,
                width: 0,
                borderLeft: `1px dashed rgba(${rgb}, 0.9)`,
              }}
            />
          )}
        <div
          ref={registerPlayhead}
          aria-hidden
          className="absolute top-0 bottom-0 pointer-events-none stash-mixer-playhead"
          style={{
            left: playheadLeft,
            width: 1,
            background: `rgba(${rgb}, 0.95)`,
            boxShadow: `0 0 6px rgba(${rgb}, 0.7)`,
            opacity: playheadVisible ? 1 : 0,
          }}
        />
      </div>
    </li>
  );
}
