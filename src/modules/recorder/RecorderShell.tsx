import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { RangeSlider } from '../../shared/ui/RangeSlider';
import { Select } from '../../shared/ui/Select';
import { MicIcon } from '../../shared/ui/icons';
import { formatDuration } from '../../shared/format/duration';
import { revealFile } from '../../shared/util/revealFile';
import { GAIN_MAX, GAIN_MIN } from './recorder.constants';
import {
  recorderDelete,
  recorderList,
  recorderRename,
  recorderSave,
  recorderSetFavorite,
} from './api';
import { useRecorderEngine } from './hooks/useRecorderEngine';
import { RecordingRow } from './components/RecordingRow';
import type { Recording } from './recorder.constants';
import './recorder.css';

type RecorderRemote = {
  action?: 'start' | 'stop' | 'toggle' | null;
  /** Input gain multiplier (1.0 = unity) pushed from the assistant / CLI. */
  gain?: number | null;
};

const formatClock = (ms: number) => formatDuration(ms, { unit: 'ms', includeHours: 'never' });

type RecorderShellProps = {
  /** When true the shell is hosted inside another tab (Valeton editor) — it
   *  sizes to its host panel and skips global keyboard shortcuts. Mirrors the
   *  Metronome's `embedded` contract. */
  embedded?: boolean;
};

export const RecorderShell = ({ embedded = false }: RecorderShellProps) => {
  const engine = useRecorderEngine();
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [pendingDelete, setPendingDelete] = useState<Recording | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Id of the take that just landed — drives a one-shot entrance animation on
  // its row, cleared shortly after so re-renders don't replay it.
  const [justAddedId, setJustAddedId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Single-player rule: each row owns an independent <AudioPlayer>, so we
  // enforce "only one plays at a time" at the DOM level. `play` doesn't
  // bubble, but a capture-phase listener on the list container still sees it
  // from any descendant <audio> — pause every other one when one starts.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onPlay = (e: Event) => {
      const target = e.target;
      if (!(target instanceof HTMLAudioElement)) return;
      el.querySelectorAll('audio').forEach((a) => {
        if (a !== target) a.pause();
      });
    };
    el.addEventListener('play', onPlay, true);
    return () => el.removeEventListener('play', onPlay, true);
  }, []);

  const refresh = useCallback(() => {
    recorderList()
      .then(setRecordings)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const stopAndSave = useCallback(async () => {
    const take = await engine.stop();
    if (!take) return;
    setSaveError(null);
    try {
      const saved = await recorderSave({
        bytes: take.bytes,
        ext: take.ext,
        durationMs: take.durationMs,
        name: `Take ${new Date().toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })}`,
        device: take.device ?? undefined,
      });
      setRecordings((prev) => [saved, ...prev]);
      setJustAddedId(saved.id);
      window.setTimeout(() => {
        setJustAddedId((id) => (id === saved.id ? null : id));
      }, 400);
    } catch (e) {
      setSaveError(String(e));
    }
  }, [engine]);

  // Agent surface — start/stop from the assistant / CLI, mirroring the
  // Metronome's `metronome:remote`. Only fires while this shell is mounted
  // (i.e. the Valeton tab has been opened); capture is inherently UI-bound.
  useEffect(() => {
    const unlisten = listen<RecorderRemote>('recorder:remote', (e) => {
      const gain = e.payload?.gain;
      if (typeof gain === 'number') engine.setGain(gain);
      const action = e.payload?.action;
      if (action === 'start' && engine.phase !== 'recording') void engine.start();
      else if (action === 'stop' && engine.phase === 'recording') void stopAndSave();
      else if (action === 'toggle') {
        if (engine.phase === 'recording') void stopAndSave();
        else void engine.start();
      }
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [engine, stopAndSave]);

  const rename = useCallback((id: string, name: string) => {
    recorderRename(id, name)
      .then((updated) => setRecordings((prev) => prev.map((r) => (r.id === id ? updated : r))))
      .catch(() => {});
  }, []);

  const toggleFavorite = useCallback((rec: Recording) => {
    recorderSetFavorite(rec.id, !rec.favorite)
      .then((updated) =>
        setRecordings((prev) => prev.map((r) => (r.id === rec.id ? updated : r))),
      )
      .catch(() => {});
  }, []);

  const doDelete = useCallback(
    (rec: Recording) => {
      recorderDelete(rec.id)
        .then(() => setRecordings((prev) => prev.filter((r) => r.id !== rec.id)))
        .catch(() => {});
    },
    [],
  );

  const requestDelete = useCallback(
    (rec: Recording) => {
      // Favorites get a confirmation gate; plain takes delete immediately.
      if (rec.favorite) setPendingDelete(rec);
      else doDelete(rec);
    },
    [doDelete],
  );

  const recording = engine.phase === 'recording';

  return (
    <div className="recorder-face flex h-full w-full flex-col p-3" data-embedded={embedded}>
      {/* List zone — sits on top so the transport controls anchor the bottom */}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        {recordings.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
            <MicIcon size={20} className="t-tertiary" />
            <p className="t-tertiary text-meta">No takes yet — hit Record to capture one.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {recordings.map((rec) => (
              <RecordingRow
                key={rec.id}
                rec={rec}
                justAdded={rec.id === justAddedId}
                onRename={(name) => rename(rec.id, name)}
                onToggleFavorite={() => toggleFavorite(rec)}
                onReveal={() => void revealFile(rec.file_path)}
                onDelete={() => requestDelete(rec)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Divider doubles as the live level meter — while recording its accent
          fill tracks the input level, so the transport strip stays slim with no
          dedicated meter row. */}
      <div
        className="recorder-divider my-2 shrink-0"
        data-recording={recording || undefined}
        aria-hidden
      >
        <span
          className="recorder-meter-fill"
          style={{ width: recording ? `${Math.round(engine.level * 100)}%` : '0%' }}
        />
      </div>

      {/* Transport zone — a slim 25px strip anchored at the bottom */}
      <div className="recorder-transport shrink-0">
        {!recording && engine.phase === 'denied' && (
          <p className="t-secondary text-meta leading-relaxed mb-2">
            Microphone blocked. Allow Stash in macOS System Settings → Privacy &amp; Security →
            Microphone, then try again.
          </p>
        )}
        {!recording && engine.phase === 'error' && engine.error && (
          <p className="t-secondary text-meta leading-relaxed mb-2">{engine.error}</p>
        )}
        {saveError && (
          <p className="t-secondary text-meta leading-relaxed mb-2">Couldn't save: {saveError}</p>
        )}

        <div className="grid grid-cols-3 items-center h-[25px]">
          {/* Left: source picker (idle) / recording badge */}
          <div className="justify-self-start">
            {recording ? (
              <div className="flex items-center gap-2 t-secondary text-meta uppercase tracking-wider">
                <span className="recorder-rec-dot" aria-hidden />
                Rec
              </div>
            ) : (
              engine.devices.length > 0 && (
                // Pointer-down unlocks real device labels on first explicit
                // intent (see `ensureLabels`) — so the source can be chosen
                // before recording, not only mid-take.
                <span onPointerDownCapture={() => void engine.ensureLabels()}>
                  <Select
                    label="Input source"
                    icon={<MicIcon size={16} />}
                    value={engine.deviceId ?? engine.devices[0]?.value ?? ''}
                    onChange={engine.setDevice}
                    options={engine.devices}
                    placement="auto"
                    footer={
                      // Input gain lives under the mic list — same popup the
                      // input is chosen in, so all capture-source settings sit
                      // together and the transport row stays uncluttered.
                      <div className="flex items-center gap-2">
                        <span className="t-tertiary text-meta shrink-0">Gain</span>
                        <RangeSlider
                          label="Input gain"
                          min={GAIN_MIN}
                          max={GAIN_MAX}
                          step={0.05}
                          value={engine.gain}
                          onChange={engine.setGain}
                          className="flex-1"
                          data-testid="recorder-gain"
                        />
                        <span className="t-secondary text-meta tabular-nums shrink-0 text-right w-9">
                          {Math.round(engine.gain * 100)}%
                        </span>
                      </div>
                    }
                  />
                </span>
              )
            )}
          </div>

          {/* Center: round record / stop button */}
          <button
            type="button"
            onClick={() => (recording ? void stopAndSave() : void engine.start())}
            className={`recorder-record-btn ring-focus justify-self-center ${
              recording ? 'is-recording' : ''
            }`}
            aria-label={recording ? 'Stop and save' : 'Record'}
            data-testid={recording ? 'recorder-stop' : 'recorder-record'}
          >
            <span className="recorder-record-glyph" aria-hidden />
          </button>

          {/* Right: elapsed clock while recording */}
          <div className="justify-self-end">
            {recording && (
              <span className="t-primary tabular-nums text-body">
                {formatClock(engine.elapsedMs)}
              </span>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete favorite recording?"
        description={
          pendingDelete
            ? `"${pendingDelete.name}" is marked as a favorite. This deletes the file permanently.`
            : undefined
        }
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => {
          if (pendingDelete) doDelete(pendingDelete);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
};
