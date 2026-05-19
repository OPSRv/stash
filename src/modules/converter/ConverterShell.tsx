import { useCallback, useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import * as api from './api';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { DropZone } from './DropZone';
import { JobRow } from './JobRow';
import { CompletedRow } from './CompletedRow';
import { ActionPicker } from './ActionPicker';
import { TranscribeOptionsModal } from './TranscribeOptionsModal';

type ShellState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'no-ffmpeg' }
  | { kind: 'ready'; status: api.ConverterStatus };

/// Top-level shell for the Convert tab.
///
/// State machine:
///   * `loading`  – initial status fetch
///   * `no-ffmpeg` – ffmpeg / ffprobe missing → hint to Settings →
///     Downloads → Install ffmpeg (same install button the downloader
///     uses, so the user only has to do this once for the whole app)
///   * `ready`    – everything wired
///
/// Cross-tab navigation: listens for `stash:navigate { tabId:
/// 'converter', file }` events so other modules (downloader,
/// clipboard) can hand off a freshly produced file. The corresponding
/// out-bound event is dispatched when the user clicks "Separate
/// stems →" — the separator shell already listens for that exact
/// shape.
export function ConverterShell() {
  const [shell, setShell] = useState<ShellState>({ kind: 'loading' });
  const [jobs, setJobs] = useState<api.ConverterJob[]>([]);
  const [pendingFile, setPendingFile] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busyKind, setBusyKind] = useState<'convert' | 'transcribe' | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<api.ConverterJob | null>(null);
  const [transcribeOpen, setTranscribeOpen] = useState(false);
  const [lastTranscribeNoteId, setLastTranscribeNoteId] = useState<number | null>(null);

  const refreshStatus = useCallback(() => {
    api
      .status()
      .then((s) =>
        setShell(s.ffmpeg_ready ? { kind: 'ready', status: s } : { kind: 'no-ffmpeg' }),
      )
      .catch((e) => setShell({ kind: 'error', message: String(e) }));
  }, []);

  useEffect(() => {
    refreshStatus();
    api
      .listJobs()
      .then((next) => setJobs(next ?? []))
      .catch(() => undefined);
  }, [refreshStatus]);

  useEffect(() => {
    const off = listen<api.ConverterJob>('converter:job', (e) => {
      setJobs((prev) => upsertJob(prev, e.payload));
    });
    return () => {
      off.then((f) => f()).catch(() => undefined);
    };
  }, []);

  // Cross-module handoff: downloader / clipboard can prime a file by
  // dispatching `stash:navigate { tabId: 'converter', file: '<path>' }`.
  useEffect(() => {
    const onNav = (ev: Event) => {
      const detail = (ev as CustomEvent<{ tabId?: string; file?: string }>).detail;
      if (detail?.tabId !== 'converter' || !detail.file) return;
      setPendingFile(detail.file);
    };
    window.addEventListener('stash:navigate', onNav as EventListener);
    return () => window.removeEventListener('stash:navigate', onNav as EventListener);
  }, []);

  const startConvert = useCallback(
    async (presetId: string) => {
      if (!pendingFile) return;
      setSubmitError(null);
      setBusyKind('convert');
      try {
        await api.run({ inputPath: pendingFile, presetId });
        setPendingFile(null);
      } catch (e) {
        setSubmitError(String(e));
      } finally {
        setBusyKind(null);
      }
    },
    [pendingFile],
  );

  const openTranscribeOptions = useCallback(() => {
    if (!pendingFile) return;
    setLastTranscribeNoteId(null);
    setTranscribeOpen(true);
  }, [pendingFile]);

  const startTranscribe = useCallback(
    (opts: Omit<api.TranscribeArgs, 'inputPath'>) => {
      if (!pendingFile) return;
      // Close the modal immediately — the job row in the queue already
      // surfaces progress, so blocking the dialog until whisper.cpp
      // finishes (can take minutes) leaves the user staring at a
      // disabled "Transcribing…" button with nothing else to do. The
      // backend keeps the promise alive so we still pick up note_id +
      // errors when it resolves.
      const file = pendingFile;
      setSubmitError(null);
      setTranscribeOpen(false);
      setPendingFile(null);
      setLastTranscribeNoteId(null);
      api
        .transcribeToFile({ inputPath: file, ...opts })
        .then((result) => {
          setLastTranscribeNoteId(result.note_id ?? null);
        })
        .catch((e) => {
          setSubmitError(String(e));
        });
    },
    [pendingFile],
  );

  const handoffStems = useCallback(() => {
    if (!pendingFile) return;
    window.dispatchEvent(
      new CustomEvent('stash:navigate', {
        detail: { tabId: 'separator', file: pendingFile },
      }),
    );
    setPendingFile(null);
  }, [pendingFile]);

  const cancelJob = useCallback((id: string) => {
    api.cancel(id).catch((e) => setSubmitError(String(e)));
  }, []);

  /// Two-step removal: a completed convert/transcribe row owns a file
  /// on disk we don't want to nuke without warning, so the X button
  /// stashes the row into `removeTarget` and lets the confirm dialog
  /// drive the actual delete. Failed / cancelled rows never wrote
  /// anything useful, so they go straight through without a dialog.
  const handleRemoveRequest = useCallback((job: api.ConverterJob) => {
    if (job.status === 'completed' && job.output_path) {
      setRemoveTarget(job);
      return;
    }
    setJobs((prev) => prev.filter((j) => j.id !== job.id));
    api.removeJob(job.id, false).catch((e) => setSubmitError(String(e)));
  }, []);

  const confirmRemove = useCallback(async () => {
    if (!removeTarget) return;
    const target = removeTarget;
    setRemoveTarget(null);
    setJobs((prev) => prev.filter((j) => j.id !== target.id));
    try {
      await api.removeJob(target.id, true);
    } catch (e) {
      setSubmitError(String(e));
    }
  }, [removeTarget]);

  const clearAllCompleted = useCallback(async () => {
    try {
      await api.clearCompleted();
      setJobs((prev) =>
        prev.filter((j) => j.status === 'queued' || j.status === 'running'),
      );
    } catch (e) {
      setSubmitError(String(e));
    }
  }, []);

  const active = useMemo(
    () => jobs.filter((j) => j.status === 'queued' || j.status === 'running'),
    [jobs],
  );
  const done = useMemo(
    () =>
      jobs.filter(
        (j) =>
          j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled',
      ),
    [jobs],
  );

  if (shell.kind === 'loading') {
    return (
      <div className="flex h-full items-center justify-center text-meta opacity-60">
        Loading…
      </div>
    );
  }
  if (shell.kind === 'error') {
    return (
      <div role="alert" className="p-6 text-body opacity-80">
        Error: {shell.message}
      </div>
    );
  }
  if (shell.kind === 'no-ffmpeg') {
    return (
      <div className="flex flex-col gap-3 p-6">
        <p className="text-body opacity-80">
          ffmpeg is not installed yet.
        </p>
        <p className="text-meta opacity-60">
          Open Settings → Downloads → Install ffmpeg. The same binary is reused
          across the downloader, the stems pipeline and this converter, so it&apos;s
          a one-time install.
        </p>
      </div>
    );
  }

  const hasContent = active.length + done.length + (pendingFile ? 1 : 0) > 0;

  return (
    <div className="flex h-full flex-col gap-4 p-4 min-h-0">
      <DropZone
        onPick={(p) => {
          setPendingFile(p);
          setSubmitError(null);
        }}
        pendingFile={pendingFile}
        compact={hasContent}
      />

      {pendingFile && (
        <ActionPicker
          file={pendingFile}
          presets={shell.status.presets}
          onConvert={startConvert}
          onTranscribe={openTranscribeOptions}
          onSeparate={handoffStems}
          onCancel={() => setPendingFile(null)}
          busyKind={busyKind}
        />
      )}

      {submitError && (
        <p role="alert" className="text-meta text-red-300/80">
          {submitError}
        </p>
      )}

      {lastTranscribeNoteId !== null && (
        <p className="text-meta opacity-70">
          Transcript saved as note ·{' '}
          <button
            type="button"
            className="underline hover:opacity-100"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent('stash:navigate', {
                  detail: { tabId: 'notes', noteId: lastTranscribeNoteId },
                }),
              );
              setLastTranscribeNoteId(null);
            }}
          >
            Open in Notes
          </button>
        </p>
      )}

      {active.length > 0 && (
        <ul className="flex flex-col gap-2" data-testid="converter-active-jobs">
          {active.map((j) => (
            <li key={j.id}>
              <JobRow job={j} onCancel={cancelJob} />
            </li>
          ))}
        </ul>
      )}

      {done.length > 0 && (
        <div
          className="flex flex-col gap-2 min-h-0 flex-1"
          data-testid="converter-completed-jobs"
        >
          <div className="flex items-center justify-between">
            <span className="text-meta opacity-60">
              Done{done.length > 1 ? ` · ${done.length}` : ''}
            </span>
            <button
              type="button"
              onClick={() => setClearOpen(true)}
              className="text-meta opacity-60 hover:opacity-100"
            >
              Clear
            </button>
          </div>
          <ul className="flex flex-col gap-2 overflow-y-auto nice-scroll pr-1 min-h-0 flex-1">
            {done.map((j) => (
              <li key={j.id}>
                <CompletedRow job={j} onRemove={handleRemoveRequest} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <ConfirmDialog
        open={clearOpen}
        title={`Clear ${done.length} entr${done.length === 1 ? 'y' : 'ies'}?`}
        description="Removes every completed entry from history and deletes their output files from disk. Active jobs are kept."
        confirmLabel="Clear"
        tone="danger"
        onConfirm={() => {
          setClearOpen(false);
          void clearAllCompleted();
        }}
        onCancel={() => setClearOpen(false)}
      />
      <TranscribeOptionsModal
        open={transcribeOpen && pendingFile !== null}
        filename={pendingFile ? pendingFile.split('/').pop() ?? pendingFile : ''}
        busy={busyKind === 'transcribe'}
        onCancel={() => setTranscribeOpen(false)}
        onConfirm={(opts) => void startTranscribe(opts)}
      />
      <ConfirmDialog
        open={removeTarget !== null}
        title="Delete output file?"
        description={
          removeTarget
            ? `Removes the entry and deletes the output file from disk:\n${removeTarget.output_path}`
            : ''
        }
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => void confirmRemove()}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  );
}

function upsertJob(
  prev: api.ConverterJob[],
  next: api.ConverterJob,
): api.ConverterJob[] {
  const idx = prev.findIndex((j) => j.id === next.id);
  if (idx < 0) return [...prev, next];
  const copy = prev.slice();
  copy[idx] = next;
  return copy;
}

export default ConverterShell;
