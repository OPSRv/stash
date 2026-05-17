import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { Button } from '../../shared/ui/Button';
import { IconButton } from '../../shared/ui/IconButton';
import { useToast } from '../../shared/ui/Toast';
import { CopyIcon, ExternalIcon, NoteIcon, PauseIcon, PlayIcon } from '../../shared/ui/icons';
import { revealFile } from '../../shared/util/revealFile';
import { mixdown, STEM_LABELS, stemColor } from './api';

interface StemMixerProps {
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
}

type LaneState = {
  /// User-set linear gain (0..1.5). >1 boosts a bit for quiet stems.
  volume: number;
  muted: boolean;
  /// At most one stem can be solo'd. When any stem is solo, every
  /// non-solo stem mutes regardless of its own mute flag.
  solo: boolean;
};

const DEFAULT_LANE: LaneState = { volume: 1, muted: false, solo: false };

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
  stems,
  durationHint,
  onReveal,
  onCopyPath,
  onCopyEmbed,
  onExtractMidi,
  midiBusy,
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

  const [lanes, setLanes] = useState<Record<string, LaneState>>(() => {
    const init: Record<string, LaneState> = {};
    for (const s of stems) init[s.name] = { ...DEFAULT_LANE };
    return init;
  });
  const [masterVolume, setMasterVolume] = useState(1);
  const [mixing, setMixing] = useState(false);

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

    (async () => {
      let longest = 0;
      for (const stem of stems) {
        try {
          const url = convertFileSrc(stem.path);
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const bytes = await res.arrayBuffer();
          const buf = await ctx.decodeAudioData(bytes);
          if (cancelled) return;
          buffersRef.current.set(stem.name, buf);
          if (buf.duration > longest) longest = buf.duration;
          const gain = ctx.createGain();
          gain.gain.value = 1;
          gain.connect(master);
          laneGainRef.current.set(stem.name, gain);
          const stemPeaks = computePeaks(buf, PEAK_BUCKETS);
          setPeaks((prev) => ({ ...prev, [stem.name]: stemPeaks }));
        } catch (e) {
          if (!cancelled) {
            setLoadError(
              `${stem.name}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          break;
        }
      }
      if (!cancelled) {
        setDuration(longest || durationHint || 0);
        setLoading(false);
      }
    })();

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
      const tick = () => {
        if (!ctxRef.current) return;
        const elapsed = ctxRef.current.currentTime - playStartTimeRef.current;
        const next = playStartOffsetRef.current + elapsed;
        if (next >= duration) {
          setPosition(duration);
          setPlaying(false);
          stopSources();
          playStartOffsetRef.current = duration;
          return;
        }
        setPosition(next);
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [play, pause, playing, position, seek]);

  // ── lane controls ────────────────────────────────────────────────
  const setLane = (name: string, patch: Partial<LaneState>) =>
    setLanes((prev) => ({
      ...prev,
      [name]: { ...(prev[name] ?? DEFAULT_LANE), ...patch },
    }));

  const toggleMute = (name: string) =>
    setLane(name, { muted: !(lanes[name]?.muted ?? false) });

  const toggleSolo = (name: string) => {
    const wasSolo = lanes[name]?.solo ?? false;
    setLanes((prev) => {
      const next: Record<string, LaneState> = {};
      for (const [k, v] of Object.entries(prev)) {
        next[k] = { ...v, solo: k === name ? !wasSolo : false };
      }
      return next;
    });
  };

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
            onMute={() => toggleMute(stem.name)}
            onSolo={() => toggleSolo(stem.name)}
            onVolume={(v) => setLane(stem.name, { volume: v })}
            onSeek={seek}
            onReveal={() => onReveal(stem.path)}
            onCopyPath={() => onCopyPath(stem.path)}
            onCopyEmbed={() => onCopyEmbed(stem.path, stem.name)}
            onExtractMidi={() => onExtractMidi(stem.path, stem.name)}
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
}: TransportProps) {
  return (
    <div className="flex items-center gap-3 px-2.5 py-1.5 border-b [border-color:var(--hairline)]">
      <IconButton
        title={playing ? 'Pause (Space)' : 'Play (Space)'}
        onClick={() => (playing ? onPause() : onPlay())}
        disabled={loading || duration === 0}
      >
        {playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
      </IconButton>
      <span className="text-meta font-mono tabular-nums t-secondary shrink-0">
        {formatClock(position)} / {formatClock(duration)}
      </span>
      <input
        type="range"
        min={0}
        max={Math.max(0.01, duration)}
        step={0.01}
        value={Math.min(position, duration || 0.01)}
        onChange={(e) => onSeek(Number(e.target.value))}
        className="flex-1 accent-[color:rgb(var(--stash-accent-rgb))]"
        aria-label="Seek"
        disabled={loading}
      />
      <div className="flex items-center gap-1 shrink-0">
        <span className="text-meta opacity-50">VOL</span>
        <input
          type="range"
          min={0}
          max={1.5}
          step={0.01}
          value={masterVolume}
          onChange={(e) => onMasterVolume(Number(e.target.value))}
          className="w-20 accent-[color:rgb(var(--stash-accent-rgb))]"
          aria-label="Master volume"
        />
      </div>
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
  onMute: () => void;
  onSolo: () => void;
  onVolume: (v: number) => void;
  onSeek: (t: number) => void;
  onReveal: () => void;
  onCopyPath: () => void;
  onCopyEmbed: () => void;
  onExtractMidi: () => void;
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
  onMute,
  onSolo,
  onVolume,
  onSeek,
  onReveal,
  onCopyPath,
  onCopyEmbed,
  onExtractMidi,
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
  }, [peaks, lane.muted, dimmed, rgb]);

  const onLaneClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const wrap = wrapRef.current;
    if (!wrap || !duration) return;
    const rect = wrap.getBoundingClientRect();
    const x = e.clientX - rect.left;
    onSeek((x / rect.width) * duration);
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
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onMute}
            aria-pressed={lane.muted}
            className="text-meta font-bold rounded px-1 py-px transition-colors"
            style={{
              background: lane.muted
                ? 'rgba(239, 68, 68, 0.25)'
                : 'rgba(255,255,255,0.05)',
              color: lane.muted ? '#fca5a5' : 'rgba(255,255,255,0.7)',
              fontSize: 9,
            }}
            title="Mute"
          >
            M
          </button>
          <button
            type="button"
            onClick={onSolo}
            aria-pressed={lane.solo}
            className="text-meta font-bold rounded px-1 py-px transition-colors"
            style={{
              background: lane.solo
                ? `rgba(${rgb}, 0.35)`
                : 'rgba(255,255,255,0.05)',
              color: lane.solo ? '#fff' : 'rgba(255,255,255,0.7)',
              fontSize: 9,
            }}
            title="Solo"
          >
            S
          </button>
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.01}
            value={lane.volume}
            onChange={(e) => onVolume(Number(e.target.value))}
            className="flex-1 min-w-0 accent-[color:rgb(var(--stash-accent-rgb))]"
            aria-label={`${label} volume`}
          />
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
        <div
          aria-hidden
          className="absolute top-0 bottom-0 pointer-events-none"
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
