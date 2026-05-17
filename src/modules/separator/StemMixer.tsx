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
import { mediaStreamUrl, mixdown, readPeaks, STEM_LABELS, stemColor, writePeaks } from './api';

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
        const elapsed = ctxRef.current.currentTime - playStartTimeRef.current;
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
        const pct =
          duration > 0
            ? `${Math.min(100, (next / duration) * 100)}%`
            : '0%';
        playheadRefs.current.forEach((el) => {
          if (el) el.style.left = pct;
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
    const elapsed = ctxRef.current.currentTime - playStartTimeRef.current;
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
  }, []);

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
      />
      {loadError && (
        <div className="px-3 py-2 text-meta" style={{ color: '#f87171' }}>
          {loadError}
        </div>
      )}
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
}: LaneProps) {
  // path is forwarded for callers that prefer absolute paths in tooltips.
  void path;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const rgb = stemColor(name);
  const label = STEM_LABELS[name] ?? name;

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
    const barWidth = canvas.width / peaks.length;
    ctx.fillStyle = `rgba(${rgb}, ${lane.muted || dimmed ? 0.18 : 0.85})`;
    for (let i = 0; i < peaks.length; i++) {
      const h = Math.max(1, peaks[i] * midY * 1.6);
      const x = i * barWidth;
      ctx.fillRect(x, midY - h, Math.max(1, barWidth - 0.5), h * 2);
    }
    // Beat grid on top of the waveform. Every 4th beat (downbeat in
    // 4/4 — a heuristic, not a true meter detection) gets a brighter
    // stroke so the eye can latch onto bars. librosa returns beats in
    // seconds, so we just project onto the canvas via duration.
    if (beats && beats.length > 0 && duration > 0) {
      ctx.lineWidth = Math.max(1, dpr);
      for (let i = 0; i < beats.length; i++) {
        const t = beats[i];
        if (t < 0 || t > duration) continue;
        const x = (t / duration) * canvas.width;
        const downbeat = i % 4 === 0;
        ctx.strokeStyle = `rgba(255, 255, 255, ${downbeat ? 0.32 : 0.14})`;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }
    }
  }, [peaks, lane.muted, dimmed, rgb, beats, duration]);

  const onLaneClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const wrap = wrapRef.current;
    if (!wrap || !duration) return;
    const rect = wrap.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const t = (x / rect.width) * duration;
    if (e.shiftKey) {
      onSetLoopPoint(t);
      return;
    }
    onSeek(t);
  };

  const playheadLeft =
    duration > 0 ? `${Math.min(100, (position / duration) * 100)}%` : '0%';

  return (
    <li
      className="group flex items-stretch gap-2 px-2 py-1.5 hover:[background:rgba(255,255,255,0.02)]"
      data-testid={`mixer-lane-${name}`}
    >
      <div className="flex flex-col gap-1 w-28 shrink-0 justify-between">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ background: `rgb(${rgb})` }}
            aria-hidden
          />
          <span
            className="text-meta t-secondary font-medium truncate"
            title={label}
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
        onClick={onLaneClick}
        className="relative flex-1 h-12 rounded-sm cursor-pointer"
        style={{
          background: `rgba(${rgb}, 0.05)`,
          boxShadow: `inset 0 0 0 1px rgba(${rgb}, 0.18)`,
        }}
      >
        <canvas ref={canvasRef} className="block w-full h-full" />
        {loop && duration > 0 && (
          <div
            aria-hidden
            className="absolute top-0 bottom-0 pointer-events-none"
            style={{
              left: `${(loop.a / duration) * 100}%`,
              width: `${((loop.b - loop.a) / duration) * 100}%`,
              background: `rgba(${rgb}, 0.18)`,
              boxShadow: `inset 1px 0 0 rgba(${rgb}, 0.8), inset -1px 0 0 rgba(${rgb}, 0.8)`,
            }}
          />
        )}
        {loopDraft !== null && duration > 0 && (
          <div
            aria-hidden
            className="absolute top-0 bottom-0 pointer-events-none"
            style={{
              left: `${(loopDraft / duration) * 100}%`,
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
          }}
        />
      </div>
    </li>
  );
}
