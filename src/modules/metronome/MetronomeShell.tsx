import { useCallback, useEffect, useRef, useState } from 'react';
import { accent } from '../../shared/theme/accent';
import { PauseIcon, PlayIcon } from '../../shared/ui/icons';
import { metronomeGetState, metronomeSaveState } from './api';
import { BPM_MAX, BPM_MIN, DEFAULT_STATE, TIME_SIGNATURES, type MetronomeState } from './metronome.constants';
import { BpmDial } from './components/BpmDial';
import { BeatStrip } from './components/BeatStrip';
import { Controls } from './components/Controls';
import { BackingTrack } from './components/BackingTrack';
import { ExtrasRow } from './components/ExtrasRow';
import { useMetronomeEngine } from './hooks/useMetronomeEngine';
import { useTapTempo } from './hooks/useTapTempo';
import { useTrainer } from './hooks/useTrainer';

const clampBpm = (v: number) => Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(v)));

const reshapeAccents = (current: boolean[], n: number): boolean[] => {
  const next: boolean[] = [];
  for (let i = 0; i < n; i++) next.push(current[i] ?? i === 0);
  return next;
};

export const MetronomeShell = () => {
  const [state, setState] = useState<MetronomeState>(DEFAULT_STATE);
  const [pulseSeq, setPulseSeq] = useState(0);
  const [pulseAccent, setPulseAccent] = useState(false);
  const [activeBeat, setActiveBeat] = useState(-1);
  const saveTimerRef = useRef<number | null>(null);
  const loadedRef = useRef(false);

  const engine = useMetronomeEngine(state);

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

  // Keyboard shortcuts (only when no input is focused).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
  }, [engine, state.bpm, state.numerator, state.denominator, setBpm, tap, patch]);

  return (
    <div className="h-full w-full flex flex-col">
      <div className="flex-1 flex items-center justify-center gap-6 px-6 py-2 min-h-0 overflow-hidden">
        <button
          type="button"
          onClick={engine.toggle}
          aria-label={engine.isPlaying ? 'Pause metronome' : 'Play metronome'}
          aria-pressed={engine.isPlaying}
          className="rounded-2xl flex items-center justify-center transition-all shrink-0"
          style={{
            width: 52,
            height: 52,
            background: engine.isPlaying ? accent(1) : accent(0.15),
            color: engine.isPlaying ? '#fff' : accent(1),
            boxShadow: engine.isPlaying
              ? `0 8px 24px -6px ${accent(0.55)}`
              : `inset 0 0 0 1px ${accent(0.35)}`,
          }}
        >
          {engine.isPlaying ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
        </button>
        <div className="flex flex-col items-center gap-2">
          <BpmDial
            bpm={state.bpm}
            onChange={setBpm}
            pulseSeq={pulseSeq}
            pulseAccent={pulseAccent}
            isPlaying={engine.isPlaying}
          />
          <BeatStrip
            numerator={state.numerator}
            accents={state.beat_accents}
            activeBeat={activeBeat}
            onToggleAccent={toggleAccent}
          />
          <button
            type="button"
            onClick={tap}
            className="seg t-secondary hover:t-primary px-4 py-1 rounded-md text-meta font-medium tracking-wider"
            style={{ minWidth: 200 }}
            data-testid="tap-tempo"
          >
            TAP
          </button>
        </div>
        <div style={{ width: 52 }} aria-hidden className="shrink-0" />
      </div>
      <Controls state={state} onPatch={patch} />
      <ExtrasRow state={state} onPatch={patch} />
      <BackingTrack
        volume={state.track_volume}
        onVolume={(v) => patch({ track_volume: v })}
      />
    </div>
  );
};
