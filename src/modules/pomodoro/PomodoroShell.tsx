import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { SegmentedControl } from '../../shared/ui/SegmentedControl';
import { Toggle } from '../../shared/ui/Toggle';
import { useToast } from '../../shared/ui/Toast';
import {
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  StopCircleIcon,
  TrashIcon,
} from '../../shared/ui/icons';
import {
  deletePreset,
  editBlocks,
  getTelegramNotifyEnabled,
  getTelegramPaired,
  listPresets,
  pauseSession,
  resumeSession,
  savePreset,
  setTelegramNotifyEnabled,
  skipTo,
  startSession,
  stopSession,
  type Block,
  type BlockChangedEvent,
  type Posture,
  type Preset,
  type PresetKind,
} from './api';
import { formatMmSs, transitionText } from './constants';
import { Timeline } from './Timeline';
import { usePomodoroEngine } from './hooks/usePomodoroEngine';
import './pomodoro.css';

const PALETTE: { posture: Posture; label: string; emoji: string; duration_sec: number }[] = [
  { posture: 'sit', label: 'Sit · 25m', emoji: '💺', duration_sec: 25 * 60 },
  { posture: 'stand', label: 'Stand · 25m', emoji: '🧍', duration_sec: 25 * 60 },
  { posture: 'walk', label: 'Walk · 10m', emoji: '🚶', duration_sec: 10 * 60 },
];

let nextSeq = 0;
const makeId = () => `b_${Date.now().toString(36)}_${(nextSeq++).toString(36)}`;

const newBlock = (posture: Posture, duration_sec: number, name?: string): Block => ({
  id: makeId(),
  name: name ?? { sit: 'Focus', stand: 'Stand', walk: 'Walk' }[posture],
  duration_sec,
  posture,
  mid_nudge_sec: null,
});

const DEFAULT_DRAFT: Block[] = [
  newBlock('sit', 25 * 60, 'Focus'),
  newBlock('stand', 15 * 60, 'Stand-up'),
  newBlock('walk', 10 * 60, 'Walk'),
];

const KIND_OPTIONS: { value: PresetKind; label: string }[] = [
  { value: 'session', label: 'Session' },
  { value: 'daily', label: 'Daily' },
];

type Banner = { from: Posture; to: Posture; block: string };

export const PomodoroShell = () => {
  const [blocks, setBlocks] = useState<Block[]>(DEFAULT_DRAFT);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<PresetKind>('session');
  const [loadedPresetId, setLoadedPresetId] = useState<number | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Preset | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const bannerTimer = useRef<number | null>(null);
  const [tgNotify, setTgNotify] = useState<boolean | null>(null);
  const [tgPaired, setTgPaired] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [enabled, paired] = await Promise.all([
          getTelegramNotifyEnabled(),
          getTelegramPaired(),
        ]);
        if (!cancelled) {
          setTgNotify(enabled);
          setTgPaired(paired);
        }
      } catch {
        if (!cancelled) setTgNotify(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleTgNotify = async (next: boolean) => {
    setTgNotify(next);
    try {
      await setTelegramNotifyEnabled(next);
    } catch {
      setTgNotify(!next);
    }
  };

  const { toast } = useToast();

  const onTransition = useCallback((ev: BlockChangedEvent) => {
    setBanner({ from: ev.from_posture, to: ev.to_posture, block: ev.block_name });
    if (bannerTimer.current) window.clearTimeout(bannerTimer.current);
    bannerTimer.current = window.setTimeout(() => setBanner(null), 5000);
  }, []);

  const onNudge = useCallback(
    (ev: { text: string; block_name: string }) => {
      toast({
        title: ev.text,
        description: ev.block_name,
        variant: 'default',
        durationMs: 4000,
      });
    },
    [toast],
  );

  const { snapshot } = usePomodoroEngine({ onTransition, onNudge });
  const isRunning = snapshot.status === 'running';
  const isPaused = snapshot.status === 'paused';
  const isActive = isRunning || isPaused;

  // Коли йде сесія — показуємо саме її блоки + позицію; редагування вимикаємо.
  const shownBlocks = isActive ? snapshot.blocks : blocks;
  const current = isActive ? snapshot.blocks[snapshot.current_idx] : null;
  const totalMs = current ? current.duration_sec * 1000 : 0;
  const blockProgress =
    totalMs > 0 ? Math.max(0, Math.min(1, 1 - snapshot.remaining_ms / totalMs)) : 0;

  const totalSec = shownBlocks.reduce((s, b) => s + b.duration_sec, 0);
  const totalMin = Math.round(totalSec / 60);

  const reloadPresets = useCallback(() => {
    listPresets()
      .then(setPresets)
      .catch(() => setPresets([]));
  }, []);

  useEffect(() => {
    reloadPresets();
  }, [reloadPresets]);

  useEffect(() => {
    return () => {
      if (bannerTimer.current) window.clearTimeout(bannerTimer.current);
    };
  }, []);

  // --- Editor actions -----------------------------------------------------
  const applyPalette = (posture: Posture, duration_sec: number) => {
    setBlocks((prev) => [...prev, newBlock(posture, duration_sec)]);
    setLoadedPresetId(null);
  };

  const handleBlocksChange = (next: Block[]) => {
    if (isActive) {
      // Під час сесії не редагуємо блоки з таймлайна напряму — тільки jumps.
      return;
    }
    setBlocks(next);
    setLoadedPresetId(null);
  };

  const handleDelete = (id: string) => {
    if (isActive) return;
    setBlocks((prev) => (prev.length <= 1 ? prev : prev.filter((b) => b.id !== id)));
    setLoadedPresetId(null);
  };

  const handleLoadPreset = (p: Preset) => {
    if (isActive) return;
    setBlocks(p.blocks.map((b) => ({ ...b })));
    setName(p.name);
    setKind(p.kind);
    setLoadedPresetId(p.id);
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed || blocks.length === 0) return;
    try {
      const saved = await savePreset(trimmed, kind, blocks);
      toast({ title: 'Preset saved', variant: 'success' });
      setLoadedPresetId(saved.id);
      reloadPresets();
    } catch (e) {
      toast({ title: 'Save failed', description: String(e), variant: 'error' });
    }
  };

  const handleDeletePreset = async () => {
    if (!confirmDelete) return;
    try {
      await deletePreset(confirmDelete.id);
      if (loadedPresetId === confirmDelete.id) setLoadedPresetId(null);
      reloadPresets();
    } finally {
      setConfirmDelete(null);
    }
  };

  // --- Transport ----------------------------------------------------------
  const handleStart = async () => {
    if (isActive) return;
    if (blocks.length === 0) return;
    try {
      await startSession(blocks, loadedPresetId);
    } catch (e) {
      toast({ title: 'Start failed', description: String(e), variant: 'error' });
    }
  };

  const handlePauseResume = async () => {
    try {
      if (isRunning) await pauseSession();
      else if (isPaused) await resumeSession();
    } catch {
      /* swallow */
    }
  };

  const handleJumpTo = async (idx: number) => {
    if (!isActive) return;
    try {
      await skipTo(idx);
    } catch {
      /* swallow */
    }
  };

  const handleStop = async () => {
    try {
      await stopSession();
    } catch {
      /* swallow */
    }
    setConfirmStop(false);
  };

  // Коли сесія закінчилась — beats стейт назад до чорнетки, якщо була.
  useEffect(() => {
    if (!isActive && snapshot.blocks.length > 0 && snapshot.status === 'idle') {
      // Залишаємо чорнетку як є; просто забуваємо сесійний snapshot (engine).
    }
  }, [isActive, snapshot.status, snapshot.blocks.length]);

  // Коли сесія стартувала й ми завантажили чорнетку з preset-а — запам'ятати
  // поточні блоки як «edit after session end».
  // (простіше — нічого не робимо, draft не змінюється під час сесії)

  // Гарячі клавіші: Space = play/pause, ⌘← / ⌘→ = skip, Esc = зняти banner.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (isActive) handlePauseResume();
        else handleStart();
      } else if (e.metaKey && e.key === 'ArrowRight' && isActive) {
        e.preventDefault();
        handleJumpTo(Math.min(snapshot.blocks.length - 1, snapshot.current_idx + 1));
      } else if (e.metaKey && e.key === 'ArrowLeft' && isActive) {
        e.preventDefault();
        handleJumpTo(Math.max(0, snapshot.current_idx - 1));
      } else if (e.key === 'Escape') {
        setBanner(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, isRunning, isPaused, snapshot.current_idx, snapshot.blocks.length]);

  const elapsedSec = useMemo(() => {
    if (!isActive) return 0;
    const past = snapshot.blocks
      .slice(0, snapshot.current_idx)
      .reduce((s, b) => s + b.duration_sec, 0);
    const currentElapsed = current
      ? current.duration_sec - Math.floor(snapshot.remaining_ms / 1000)
      : 0;
    return past + Math.max(0, currentElapsed);
  }, [isActive, snapshot, current]);

  const canGoBack = isActive && snapshot.current_idx > 0;
  const canGoForward = isActive && snapshot.current_idx < snapshot.blocks.length - 1;

  // Якщо змінили назву блока під час сесії через double-click — ігноруємо:
  // для цього Timeline в playing-режимі просто не приймає onChange.

  const handleRenameInSession = async (next: Block[]) => {
    if (!isActive) return;
    try {
      await editBlocks(next);
    } catch {
      /* swallow */
    }
  };
  void handleRenameInSession; // reserved (зараз редагування вимкнено в playing-mode)

  return (
    <div className="pom-root flex flex-col h-full">
      {/* --- Header (назва + kind + total + save) --- */}
      <header className="flex items-center gap-3 px-4 py-2.5 border-b hair relative z-10">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={kind === 'session' ? 'Session name…' : 'Daily plan name…'}
          className="pom-name-input flex-1 min-w-0"
          disabled={isActive}
          aria-label="Preset name"
        />
        <SegmentedControl<PresetKind>
          size="sm"
          value={kind}
          onChange={setKind}
          options={KIND_OPTIONS}
          ariaLabel="Preset kind"
        />
        <span className="t-tertiary text-meta font-mono tabular-nums shrink-0">
          {totalMin}m · {shownBlocks.length} {shownBlocks.length === 1 ? 'block' : 'blocks'}
        </span>
        <button
          type="button"
          onClick={handleSave}
          disabled={!name.trim() || blocks.length === 0 || isActive}
          className="pom-save-pill"
          data-testid="pom-save-preset"
        >
          {loadedPresetId != null ? 'Update' : '+ Save'}
        </button>
      </header>

      {/* --- Banner (transition hint) --- */}
      {banner && (
        <div className="pom-banner" role="status">
          <span aria-hidden style={{ fontSize: 16 }}>
            {banner.to === 'sit' ? '💺' : banner.to === 'stand' ? '🧍' : '🚶'}
          </span>
          <span className="t-primary text-body font-medium flex-1">
            {transitionText(banner.from, banner.to)}
          </span>
          <span className="t-tertiary text-meta">→ {banner.block}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="pom-pill"
            style={{ height: 24, padding: '0 10px', fontSize: 10 }}
          >
            Got it
          </button>
        </div>
      )}

      {/* --- Hero --- */}
      <div
        className="pom-hero flex flex-col items-center justify-center gap-3 px-8 py-5"
        data-running={isRunning}
      >
        {isActive && current ? (
          <>
            <div className="pom-hero-label relative z-10">
              Block {snapshot.current_idx + 1} / {snapshot.blocks.length} · {current.name}
            </div>
            <div
              className={`pom-clock-digits relative z-10 ${isPaused ? 'pom-clock-paused' : ''}`}
              aria-live="polite"
              aria-label={`${formatMmSs(snapshot.remaining_ms)} remaining`}
            >
              {formatMmSs(snapshot.remaining_ms)}
            </div>
            <div className="flex items-center gap-2 relative z-10">
              <button
                type="button"
                onClick={() => handleJumpTo(snapshot.current_idx - 1)}
                disabled={!canGoBack}
                aria-label="Previous block"
                className="pom-pill pom-icon-pill"
              >
                <PrevIcon size={13} />
              </button>
              <button
                type="button"
                onClick={handlePauseResume}
                data-running={isRunning}
                aria-label={isRunning ? 'Pause' : 'Resume'}
                className="pom-pill pom-pill-primary"
              >
                {isRunning ? <PauseIcon size={12} /> : <PlayIcon size={12} />}
                <span>{isRunning ? 'PAUSE' : 'RESUME'}</span>
              </button>
              <button
                type="button"
                onClick={() => handleJumpTo(snapshot.current_idx + 1)}
                disabled={!canGoForward}
                aria-label="Next block"
                className="pom-pill pom-icon-pill"
              >
                <NextIcon size={13} />
              </button>
              <button
                type="button"
                onClick={() => setConfirmStop(true)}
                aria-label="Stop session"
                className="pom-pill pom-pill-danger pom-icon-pill"
              >
                <StopCircleIcon size={13} />
              </button>
            </div>
            <div className="t-tertiary text-meta font-mono tabular-nums relative z-10">
              {Math.floor(elapsedSec / 60)}m / {totalMin}m
            </div>
          </>
        ) : (
          <>
            <div className="pom-hero-label relative z-10">Ready · space to start</div>
            <div className="pom-clock-digits relative z-10" aria-label="Total duration">
              {totalMin}
              <span style={{ fontSize: 40, marginLeft: 6 }}>m</span>
            </div>
            <button
              type="button"
              onClick={handleStart}
              disabled={blocks.length === 0}
              className="pom-pill pom-pill-primary relative z-10"
              data-testid="pom-start"
            >
              <PlayIcon size={12} />
              <span>START</span>
            </button>
          </>
        )}
      </div>

      {/* --- Timeline --- */}
      <Timeline
        blocks={shownBlocks}
        mode={isActive ? 'playing' : 'edit'}
        onChange={handleBlocksChange}
        onDelete={handleDelete}
        currentIdx={isActive ? snapshot.current_idx : undefined}
        progress={isActive ? blockProgress : undefined}
        onJumpTo={handleJumpTo}
      />

      {/* --- Palette (тільки в edit mode) --- */}
      {!isActive && (
        <div className="pom-palette shrink-0">
          <span className="section-label shrink-0">Add</span>
          {PALETTE.map((p) => (
            <button
              key={p.posture}
              type="button"
              onClick={() => applyPalette(p.posture, p.duration_sec)}
              data-posture={p.posture}
              className="pom-palette-btn"
              data-testid={`pom-palette-${p.posture}`}
            >
              <span aria-hidden>{p.emoji}</span>
              <span>+ {p.label}</span>
            </button>
          ))}
          <div className="flex-1" />
          <span className="t-tertiary text-meta italic">
            drag to reorder · drag edge to resize · dbl-click to rename · right-click for more
          </span>
        </div>
      )}

      <div className="flex-1" />

      {/* --- Telegram notifications toggle --- */}
      {tgNotify !== null && (
        <div
          className="flex items-center gap-2 px-4 py-1.5 border-t hair shrink-0"
          data-testid="pom-tg-notify-row"
        >
          <span className="text-meta t-secondary">Telegram alerts</span>
          <span className="t-tertiary text-meta">
            {tgPaired ? 'on block change + session done' : 'pair a chat in Telegram tab first'}
          </span>
          <div className="flex-1" />
          <div style={{ opacity: tgPaired ? 1 : 0.4, pointerEvents: tgPaired ? 'auto' : 'none' }}>
            <Toggle
              checked={tgNotify}
              onChange={toggleTgNotify}
              label="Send pomodoro events to Telegram"
            />
          </div>
        </div>
      )}

      {/* --- Presets chips --- */}
      <footer className="pom-presets-bar border-t hair mt-auto shrink-0">
        <span className="section-label shrink-0">Presets</span>
        <div className="flex items-center gap-2 flex-1 min-w-0 overflow-x-auto nice-scroll">
          {presets.length === 0 ? (
            <span className="t-tertiary text-meta italic">
              No presets yet — compose blocks above and hit Save.
            </span>
          ) : (
            presets.map((p) => (
              <div key={p.id} className="shrink-0 inline-flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => handleLoadPreset(p)}
                  disabled={isActive}
                  data-active={loadedPresetId === p.id}
                  className="pom-preset-chip"
                  data-testid={`pom-preset-${p.id}`}
                  title={`${p.kind} · ${p.blocks.length} blocks`}
                >
                  <span>{p.name}</span>
                  <span className="t-tertiary font-mono">
                    {Math.round(p.blocks.reduce((s, b) => s + b.duration_sec, 0) / 60)}m
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(p)}
                  disabled={isActive}
                  aria-label={`Delete preset ${p.name}`}
                  className="pom-pill pom-icon-pill"
                  style={{ height: 22, width: 22 }}
                >
                  <TrashIcon size={10} />
                </button>
              </div>
            ))
          )}
        </div>
      </footer>

      <ConfirmDialog
        open={confirmStop}
        title="Stop this session?"
        description="Progress so far is saved to history."
        confirmLabel="Stop"
        tone="danger"
        onConfirm={handleStop}
        onCancel={() => setConfirmStop(false)}
      />
      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Delete "${confirmDelete?.name ?? ''}"?`}
        description="The preset will be removed. Sessions you already ran keep their own copy."
        confirmLabel="Delete"
        tone="danger"
        onConfirm={handleDeletePreset}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
};
