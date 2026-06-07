import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { CloseIcon, PauseIcon, PlayIcon } from '../../shared/ui/icons';
import { IconButton } from '../../shared/ui/IconButton';
import { Footswitch } from '../../shared/ui/pedal/Footswitch';
import { PedalEnclosure } from '../../shared/ui/pedal/PedalEnclosure';
import '../../shared/ui/pedal/pedal.css';
import './metronome.css';
import { metronomeGetState, metronomeSaveState } from './api';
import { BPM_MAX, BPM_MIN, DEFAULT_STATE, SOUND_PRESETS, TIME_SIGNATURES, tempoName, type MetronomeState, type SoundId } from './metronome.constants';

type MetronomeRemote = {
  action?: 'start' | 'stop' | 'toggle' | 'status' | null;
  bpm?: number | null;
  numerator?: number | null;
  denominator?: number | null;
  subdivision?: number | null;
  sound?: string | null;
};
import { RangeSlider } from '../../shared/ui/RangeSlider';
import { BpmDial } from './components/BpmDial';
import { BeatStrip } from './components/BeatStrip';
import { Controls } from './components/Controls';
import { ExtrasRow } from './components/ExtrasRow';
import { SetupRow } from './components/SetupRow';
import { useMetronomeEngine } from './hooks/useMetronomeEngine';
import { useTapTempo } from './hooks/useTapTempo';
import { useTrainer } from './hooks/useTrainer';

const clampBpm = (v: number) => Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(v)));

const reshapeAccents = (current: boolean[], n: number): boolean[] => {
  const next: boolean[] = [];
  for (let i = 0; i < n; i++) next.push(current[i] ?? i === 0);
  return next;
};

type MetronomeShellProps = {
  /** When true the shell is hosted inside another tab (Valeton editor).
   *  The pedal fills its slot and manages its own overflow (the setup bay
   *  slides over the face), so the host needs no scroll wrapper; the global
   *  keyboard shortcuts are skipped — the host owns the keyboard. */
  embedded?: boolean;
};

export const MetronomeShell = ({ embedded = false }: MetronomeShellProps) => {
  const [state, setState] = useState<MetronomeState>(DEFAULT_STATE);
  const [pulseSeq, setPulseSeq] = useState(0);
  const [pulseAccent, setPulseAccent] = useState(false);
  const [activeBeat, setActiveBeat] = useState(-1);
  const [setupOpen, setSetupOpen] = useState(false);
  const saveTimerRef = useRef<number | null>(null);
  const loadedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const heroRef = useRef<HTMLDivElement | null>(null);
  const [dialSize, setDialSize] = useState(160);

  const engine = useMetronomeEngine(state);

  // The tempo wheel is the hero — size it to the largest circle that fits the
  // hero box so it fills the panel width (capped by the height the footswitch
  // row + status strip leave). Measured up front so the fit applies before the
  // browser paints (no resize flash). The 14px gutter keeps the breathing glow
  // and pulse ring from clipping at the box edge.
  useLayoutEffect(() => {
    const el = heroRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      const fit = Math.min(r.width, r.height) - 14;
      // Cap the hero so the tempo wheel stops out-competing the signal chain
      // for attention when the tools-bay slot is wide; floor keeps it legible.
      setDialSize(Math.min(168, Math.max(120, Math.round(fit))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Hydrate from disk on first mount.
  useEffect(() => {
    metronomeGetState()
      .then((s) => {
        setState({
          ...DEFAULT_STATE,
          ...s,
          beat_accents: reshapeAccents(s.beat_accents ?? [], s.numerator ?? DEFAULT_STATE.numerator),
        });
      })
      .catch(() => {})
      .finally(() => {
        loadedRef.current = true;
      });
  }, []);

  // Debounced save on every state change.
  useEffect(() => {
    if (!loadedRef.current) return;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      metronomeSaveState(state).catch(() => {});
    }, 200);
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    };
  }, [state]);

  // Beat dot animation hook.
  useEffect(() => {
    return engine.onBeat((beatDot, accent) => {
      setActiveBeat(beatDot);
      setPulseAccent(accent);
      setPulseSeq((s) => s + 1);
    });
  }, [engine]);

  // Reset active dot whenever play stops.
  useEffect(() => {
    if (!engine.isPlaying) setActiveBeat(-1);
  }, [engine.isPlaying]);

  const patch = useCallback((p: Partial<MetronomeState>) => {
    setState((prev) => {
      let next = { ...prev, ...p };
      if (p.numerator !== undefined && p.numerator !== prev.numerator) {
        next.beat_accents = reshapeAccents(prev.beat_accents, p.numerator);
      }
      return next;
    });
  }, []);

  const setBpm = useCallback((bpm: number) => patch({ bpm: clampBpm(bpm) }), [patch]);
  const tap = useTapTempo(setBpm);

  useTrainer({ engine, bpm: state.bpm, config: state.trainer, onBpmChange: setBpm });

  const toggleAccent = useCallback((idx: number) => {
    setState((prev) => {
      const next = [...prev.beat_accents];
      next[idx] = !next[idx];
      return { ...prev, beat_accents: next };
    });
  }, []);

  // Remote control from the assistant / CLI. Agent surface (CLAUDE.md) —
  // any new user-facing metronome knob MUST be reachable from here so the
  // assistant can drive it; keep this listener's switch in sync with
  // `parse_metronome_args` on the Rust side.
  useEffect(() => {
    const unlisten = listen<MetronomeRemote>('metronome:remote', (e) => {
      const p = e.payload ?? {};
      const patchFields: Partial<MetronomeState> = {};
      if (typeof p.bpm === 'number') patchFields.bpm = clampBpm(p.bpm);
      if (typeof p.numerator === 'number') patchFields.numerator = p.numerator;
      if (typeof p.denominator === 'number' && (p.denominator === 2 || p.denominator === 4 || p.denominator === 8)) {
        patchFields.denominator = p.denominator;
      }
      if (typeof p.subdivision === 'number' && p.subdivision >= 1 && p.subdivision <= 4) {
        patchFields.subdivision = p.subdivision as 1 | 2 | 3 | 4;
      }
      if (typeof p.sound === 'string' && SOUND_PRESETS.some((s) => s.id === p.sound)) {
        patchFields.sound = p.sound as SoundId;
      }
      if (Object.keys(patchFields).length > 0) patch(patchFields);
      switch (p.action) {
        case 'start':
          if (!engine.isPlaying) engine.start();
          break;
        case 'stop':
          if (engine.isPlaying) engine.stop();
          break;
        case 'toggle':
          engine.toggle();
          break;
        default:
          break;
      }
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [engine, patch]);

  // Keyboard shortcuts (only when this tab is active and no input is focused).
  // Skipped when embedded — the host tab (Valeton editor) owns the keyboard
  // and binds Space / digits / arrows to its own actions; sharing them would
  // make both fire on one keypress.
  useEffect(() => {
    if (embedded) return;
    const onKey = (e: KeyboardEvent) => {
      if (rootRef.current?.closest('[hidden]')) return;
      const t = e.target as HTMLElement | null;
      const typing =
        t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (typing) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          engine.toggle();
          return;
        case 'ArrowUp':
          e.preventDefault();
          setBpm(state.bpm + (e.shiftKey ? 5 : 1));
          return;
        case 'ArrowDown':
          e.preventDefault();
          setBpm(state.bpm - (e.shiftKey ? 5 : 1));
          return;
        case 't':
        case 'T':
          e.preventDefault();
          tap();
          return;
        case '1':
        case '2':
        case '3':
        case '4':
          e.preventDefault();
          patch({ subdivision: Number(e.key) as 1 | 2 | 3 | 4 });
          return;
        case '[':
        case ']': {
          e.preventDefault();
          const idx = TIME_SIGNATURES.findIndex(
            (s) => s.numerator === state.numerator && s.denominator === state.denominator,
          );
          const cur = idx === -1 ? 2 : idx;
          const dir = e.key === ']' ? 1 : -1;
          const ni = (cur + dir + TIME_SIGNATURES.length) % TIME_SIGNATURES.length;
          patch({
            numerator: TIME_SIGNATURES[ni].numerator,
            denominator: TIME_SIGNATURES[ni].denominator,
          });
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [embedded, engine, state.bpm, state.numerator, state.denominator, setBpm, tap, patch]);

  return (
    <PedalEnclosure
      className="flex flex-col"
      radius={12}
      playing={engine.isPlaying}
      showBolts={false}
      data-testid="metronome-shell"
    >
      <div ref={rootRef} className="flex flex-1 flex-col gap-2 px-3.5 pb-2 pt-3">
        {/* Hero — the tempo wheel, sized to the largest circle that fits this
            box so it dominates the face (see `dialSize` above). */}
        <div ref={heroRef} className="flex min-h-0 flex-1 items-center justify-center">
          <BpmDial
            bpm={state.bpm}
            onChange={setBpm}
            pulseSeq={pulseSeq}
            pulseAccent={pulseAccent}
            isPlaying={engine.isPlaying}
            size={dialSize}
          />
        </div>

        {/* Footswitches — the tactile transport row. */}
        <div className="flex shrink-0 items-end justify-center gap-3">
          <Footswitch
            onClick={engine.toggle}
            ariaLabel={engine.isPlaying ? 'Pause metronome' : 'Play metronome'}
            caption={engine.isPlaying ? 'STOP' : 'PLAY'}
            lit={engine.isPlaying}
            active={engine.isPlaying}
          >
            {engine.isPlaying ? <PauseIcon size={15} /> : <PlayIcon size={15} />}
          </Footswitch>
          <Footswitch onClick={tap} ariaLabel="Tap tempo" caption="TAP" testId="tap-tempo">
            <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="8" cy="8" r="2" fill="currentColor" />
            </svg>
          </Footswitch>
        </div>

        {/* Thin status strip pinned to the very bottom — beat LEDs + the etched
            LCD readout centred as one ribbon, with the setup key (icon-only)
            tucked at the right edge. The empty left cell balances the icon so
            the readout sits dead-centre. */}
        <div className="pedal-window metro-strip" data-playing={engine.isPlaying}>
          <span aria-hidden="true" />
          <div className="metro-strip-main">
            <BeatStrip
              numerator={state.numerator}
              accents={state.beat_accents}
              activeBeat={activeBeat}
              onToggleAccent={toggleAccent}
            />
            <div className="pedal-readout text-meta flex items-center gap-2">
              <span>
                {state.numerator}/{state.denominator}
              </span>
              <span className="pedal-readout-dim">·</span>
              <span>{tempoName(state.bpm)}</span>
              <span className="pedal-readout-dim">·</span>
              <span className="tabular-nums">{state.bpm} BPM</span>
            </div>
          </div>
          {/* Setup key — slides the controls / levels / trainer / presets bay
              over the face so the deck itself never needs to scroll. */}
          <IconButton
            onClick={() => setSetupOpen(true)}
            title="Controls · Levels · Trainer"
            active={setupOpen}
            tooltipSide="top"
            data-testid="metro-setup-open"
          >
            <svg width="13" height="13" viewBox="0 0 11 11" fill="none" aria-hidden="true">
              <line x1="0.5" y1="3" x2="10.5" y2="3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="3.5" cy="3" r="2" fill="currentColor" />
              <line x1="0.5" y1="8" x2="10.5" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="7.5" cy="8" r="2" fill="currentColor" />
            </svg>
          </IconButton>
        </div>
      </div>

      {/* Slide-over setup bay — the optional, less-frequent controls. Mounted
          always for the transition; `inert` + pointer-events drop it from the
          a11y / tab order while closed. */}
      <div className="metro-setup" data-open={setupOpen || undefined} inert={!setupOpen}>
        <div className="metro-setup-head">
          <span className="field-label">Setup</span>
          <IconButton onClick={() => setSetupOpen(false)} title="Close setup" tooltipSide="left" data-testid="metro-setup-close">
            <CloseIcon size={15} />
          </IconButton>
        </div>
        <div className="metro-setup-body scroll-area">
          {/* One flat sheet of hair-lined rows — Signature · Division · Sound ·
              Levels · Trainer · Presets — each a caption-left / control-right
              row. The dividers come from `.metro-row + .metro-row`, so rows
              from the three components still line up under this one parent. */}
          <div className="metro-setup-list">
            <Controls state={state} onPatch={patch} />
            <SetupRow label="Levels">
              <div className="metro-levels">
                <div className="metro-level">
                  <span className="metro-level-name">Click</span>
                  <RangeSlider
                    value={state.click_volume}
                    onChange={(v) => patch({ click_volume: v })}
                    min={0}
                    max={1}
                    step={0.01}
                    label="Click"
                    data-testid="vol-click"
                  />
                  <span className="metro-level-pct">{Math.round(state.click_volume * 100)}%</span>
                </div>
                <div className="metro-level">
                  <span className="metro-level-name">Accent</span>
                  <RangeSlider
                    value={state.accent_volume}
                    onChange={(v) => patch({ accent_volume: v })}
                    min={0}
                    max={1}
                    step={0.01}
                    label="Accent"
                    data-testid="vol-accent"
                  />
                  <span className="metro-level-pct">{Math.round(state.accent_volume * 100)}%</span>
                </div>
              </div>
            </SetupRow>
            <ExtrasRow state={state} onPatch={patch} />
          </div>
        </div>
      </div>
    </PedalEnclosure>
  );
};
