/* DrumsShell — step-sequencer drum machine hosted by the Valeton editor's
 * `Drums` view (no tab of its own, like the Circle of Fifths). Standalone
 * module: own Rust state (`drums.json`), own agent surface
 * (`/drums` + `drums_control` → `drums:remote`).
 *
 * The Valeton shell keeps this mounted once visited and only hides it, so
 * the groove keeps playing while you tweak the pedal chain. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { useTapTempo } from '../../shared/hooks/useTapTempo';
import { useToast } from '../../shared/ui/Toast';
import { revealFile } from '../../shared/util/revealFile';
import { withPopupPinned } from '../../shared/util/withPopupPinned';
import {
  drumsDefaultExportDir,
  drumsExport,
  drumsFfmpegAvailable,
  drumsGetState,
  drumsSaveState,
} from './api';
import { ExportModal } from './components/ExportModal';
import { StepGrid } from './components/StepGrid';
import { TransportBar } from './components/TransportBar';
import { useDrumEngine } from './hooks/useDrumEngine';
import {
  BPM_MAX,
  BPM_MIN,
  METER_GRID,
  normalizeState,
  type DrumsState,
  type DrumVoice,
  type ExportFormat,
  type Step,
  type VoiceMix,
} from './lib/model';
import { applyPreset, DEFAULT_STATE, findPreset } from './lib/presets';
import { applyRemote, type DrumsRemote, type DrumsRemoteAck } from './lib/remote';
import { loopSeconds, renderLoopWav } from './lib/render';
import './drums.css';

const exportFileName = (s: DrumsState, bars: number, format: ExportFormat): string => {
  const base = findPreset(s.preset_id)?.id ?? 'custom';
  return `${base}-${s.bpm}bpm-${bars}bar${bars > 1 ? 's' : ''}.${format}`;
};

const joinPath = (dir: string, name: string) => `${dir.replace(/\/+$/, '')}/${name}`;

export const DrumsShell = () => {
  const [state, setState] = useState<DrumsState>(DEFAULT_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const loadedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const engine = useDrumEngine(state);
  const { toast } = useToast();

  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [ffmpeg, setFfmpeg] = useState(false);

  // Hydrate from disk once.
  useEffect(() => {
    drumsGetState()
      .then((s) => setState(normalizeState(s, DEFAULT_STATE)))
      .catch(() => {})
      .finally(() => {
        loadedRef.current = true;
      });
  }, []);

  // Debounced persist.
  useEffect(() => {
    if (!loadedRef.current) return;
    const id = window.setTimeout(() => {
      drumsSaveState(state).catch(() => {});
    }, 300);
    return () => window.clearTimeout(id);
  }, [state]);

  const patch = useCallback((p: Partial<DrumsState>) => {
    setState((prev) => normalizeState({ ...prev, ...p }, prev));
  }, []);

  const setCell = useCallback((voice: DrumVoice, col: number, value: Step) => {
    setState((prev) => {
      const row = [...prev.steps[voice]];
      row[col] = value;
      return { ...prev, steps: { ...prev.steps, [voice]: row }, preset_id: null };
    });
  }, []);

  const setMix = useCallback((voice: DrumVoice, p: Partial<VoiceMix>) => {
    setState((prev) => ({ ...prev, mix: { ...prev.mix, [voice]: { ...prev.mix[voice], ...p } } }));
  }, []);

  const loadPreset = useCallback((id: string) => {
    const preset = findPreset(id);
    if (preset) setState((prev) => applyPreset(prev, preset));
  }, []);

  const setBpm = useCallback((bpm: number) => patch({ bpm }), [patch]);
  const tap = useTapTempo(setBpm, BPM_MIN, BPM_MAX);

  /** Render + write. `path` given → no dialog (assistant export). Returns
   *  the final path, or null when the user cancelled the dialog. */
  const exportLoop = useCallback(
    async (bars: number, format: ExportFormat, path?: string): Promise<string | null> => {
      const s = stateRef.current;
      let target = path;
      if (!target) {
        const dir = await drumsDefaultExportDir().catch(() => '');
        const picked = await withPopupPinned(() =>
          saveDialog({
            defaultPath: joinPath(dir, exportFileName(s, bars, format)),
            filters: [{ name: format.toUpperCase(), extensions: [format] }],
          }),
        );
        if (!picked) return null;
        target = picked;
      }
      const wav = await renderLoopWav(s, bars);
      return drumsExport(wav, target, format);
    },
    [],
  );

  const onSaveExport = useCallback(async () => {
    const s = stateRef.current;
    setExporting(true);
    try {
      const out = await exportLoop(s.export_bars, s.export_format);
      if (!out) return;
      setExportOpen(false);
      toast({
        title: 'Loop exported',
        description: out,
        variant: 'success',
        action: { label: 'Reveal', onClick: () => void revealFile(out).catch(() => {}) },
      });
    } catch (e) {
      toast({ title: 'Export failed', description: String(e), variant: 'error' });
    } finally {
      setExporting(false);
    }
  }, [exportLoop, toast]);

  const openExport = useCallback(() => {
    setExportOpen(true);
    drumsFfmpegAvailable()
      .then((ok) => {
        setFfmpeg(ok);
        // Don't leave the dialog on a format that can't be produced.
        if (!ok && stateRef.current.export_format === 'mp3') patch({ export_format: 'wav' });
      })
      .catch(() => setFfmpeg(false));
  }, [patch]);

  // Assistant / CLI / Telegram (`drums:remote`). Bound once; engine and
  // state read through refs. Every payload is acked so Rust stops
  // re-emitting; re-emits carry the same ack_id and are applied once.
  const engineRef = useRef(engine);
  useLayoutEffect(() => {
    engineRef.current = engine;
  });
  const lastAckRef = useRef<number | null>(null);
  useEffect(() => {
    const un = listen<DrumsRemote>('drums:remote', async (e) => {
      const p = e.payload ?? {};
      const ackId = typeof p.ack_id === 'number' ? p.ack_id : null;
      if (ackId !== null && ackId === lastAckRef.current) return;
      lastAckRef.current = ackId;
      const eng = engineRef.current;
      const next = applyRemote(stateRef.current, p);
      if (next !== stateRef.current) {
        stateRef.current = next;
        setState(next);
      }
      let playing = eng.isPlaying;
      if (p.action === 'start' || (p.action === 'toggle' && !playing)) {
        if (!playing) eng.start();
        playing = true;
      } else if (p.action === 'stop' || (p.action === 'toggle' && playing)) {
        eng.stop();
        playing = false;
      }
      const ack: DrumsRemoteAck = {
        ack_id: ackId,
        playing,
        bpm: next.bpm,
        preset_id: next.preset_id,
      };
      if (p.export) {
        try {
          const name = exportFileName(next, p.export.bars, p.export.format);
          ack.exported_path =
            (await exportLoop(p.export.bars, p.export.format, joinPath(p.export.dir, name))) ??
            undefined;
        } catch (err) {
          ack.error = String(err);
        }
      }
      void emit('drums:remote:ack', ack);
    });
    return () => {
      void un.then((f) => f());
    };
  }, [exportLoop]);

  // Space = play/stop while the Drums view is visible, unless a field or a
  // control that owns Space (grid cells, buttons, sliders) is focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!rootRef.current || rootRef.current.offsetParent === null) return;
      if (exportOpen) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && el !== document.body) {
        const tag = el.tagName.toUpperCase();
        if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(tag) || el.isContentEditable) return;
        if (el.getAttribute('role') && el.getAttribute('role') !== 'tabpanel') return;
      }
      e.preventDefault();
      engineRef.current.toggle();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [exportOpen]);

  const grid = METER_GRID[state.meter];
  const exportSeconds = loopSeconds(state, state.export_bars);

  return (
    <div ref={rootRef} className="drums-root flex h-full min-h-0 flex-col gap-2.5">
      <TransportBar
        state={state}
        isPlaying={engine.isPlaying}
        onToggle={engine.toggle}
        onPreset={loadPreset}
        onPatch={patch}
        onTap={tap}
        onExport={openExport}
      />
      <StepGrid
        state={state}
        stepsPerBeat={grid.stepsPerBeat}
        stepsPerBar={grid.stepsPerBar}
        isPlaying={engine.isPlaying}
        onCell={setCell}
        onMix={setMix}
        onPreview={engine.preview}
        subscribeStep={engine.onStep}
      />
      <p className="t-tertiary text-meta shrink-0">
        Click a step to add a hit · ⌥-click for an accent · drag to paint · click a name to preview
      </p>
      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        bars={state.export_bars}
        format={state.export_format}
        patternBars={state.bars}
        ffmpegAvailable={ffmpeg}
        durationLabel={`${exportSeconds.toFixed(1)} s at ${state.bpm} BPM`}
        busy={exporting}
        onChange={patch}
        onSave={() => void onSaveExport()}
      />
    </div>
  );
};
