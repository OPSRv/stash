import { useState } from 'react';
import { AudioPlayer } from '../../shared/ui/AudioPlayer';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { IconButton } from '../../shared/ui/IconButton';
import { CloseIcon, ExternalIcon } from '../../shared/ui/icons';
import { useToast } from '../../shared/ui/Toast';
import { accent } from '../../shared/theme/accent';
import { revealFile } from '../../shared/util/revealFile';
import { formatDuration } from '../../shared/format/duration';
import { buildAudioEmbed } from '../notes/audioEmbed';
import { STEM_LABELS, deleteStem, extractChords, extractMidi, stemColor, type ChordSegment, type SeparatorJob } from './api';
import { StemMixer } from './StemMixer';

type CompletedRowProps = {
  job: SeparatorJob;
  onRemove: (jobId: string) => void;
  /** When `true`, the row mounts in expanded state — the master player
   *  + stem grid + per-stem `<audio>` are rendered immediately. When
   *  `false` (default), only the header is mounted; clicking it
   *  expands the row and lazy-mounts the players. The shell passes
   *  `defaultExpanded={index === 0}` so the most-recent job is open. */
  defaultExpanded?: boolean;
  /** Subtle accent-tinted gradient on the header — used by the shell
   *  for the most-recent job to draw the eye. */
  isFirst?: boolean;
};

export function CompletedRow({
  job,
  onRemove,
  defaultExpanded = true,
  isFirst = false,
}: CompletedRowProps) {
  const { toast } = useToast();
  const [removeOpen, setRemoveOpen] = useState(false);
  const [midiBusy, setMidiBusy] = useState<string | null>(null);
  // Pending per-stem delete — when set, a confirm dialog is shown.
  // Cleared on confirm (after the backend drops the file) or cancel.
  const [stemDelete, setStemDelete] = useState<{
    name: string;
    path: string;
  } | null>(null);
  // Lazily-computed chord track. Cached in localStorage per job so a
  // 10–30 s detection only runs once per song. `null` = not requested
  // yet, `[]` = ran but produced nothing, otherwise the segments.
  const chordKey = `stash:separator:chords:${job.id}`;
  const [chords, setChords] = useState<ChordSegment[] | null>(() => {
    try {
      const raw = localStorage.getItem(chordKey);
      return raw ? (JSON.parse(raw) as ChordSegment[]) : null;
    } catch {
      return null;
    }
  });
  const [chordsBusy, setChordsBusy] = useState(false);

  const runChordDetection = async () => {
    if (chordsBusy) return;
    setChordsBusy(true);
    try {
      const segments = await extractChords(job.input_path);
      setChords(segments);
      try {
        localStorage.setItem(chordKey, JSON.stringify(segments));
      } catch {
        // Quota — chords are pure UX sugar, fine to lose.
      }
    } catch (e) {
      toast({
        title: 'Chord detection failed',
        description: String(e),
        variant: 'error',
      });
    } finally {
      setChordsBusy(false);
    }
  };

  // Audio → MIDI for one stem via the basic-pitch helper in the
  // separator venv. Drops the resulting .mid next to the source stem,
  // reveals it in Finder, and surfaces a toast so the user knows
  // where to drag it from.
  const extractStemMidi = async (path: string, stemName: string) => {
    setMidiBusy(stemName);
    try {
      const midi = await extractMidi(path);
      toast({
        title: 'MIDI ready',
        description: midi,
        variant: 'success',
      });
      try {
        await revealFile(midi);
      } catch {
        // reveal-in-Finder is a convenience; the toast already says
        // where the file is.
      }
    } catch (e) {
      toast({
        title: 'MIDI extraction failed',
        description: String(e),
        variant: 'error',
      });
    } finally {
      setMidiBusy(null);
    }
  };
  const [expanded, setExpanded] = useState(defaultExpanded);
  const stems = job.result?.stems ?? {};
  const stemEntries = Object.entries(stems);

  const failed = job.status === 'failed';
  const cancelled = job.status === 'cancelled';
  // Failed jobs have nothing to expand — collapse permanently.
  const expandable = !failed && (stemEntries.length > 0 || job.input_path.startsWith('/'));
  const isOpen = expandable && expanded;

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      toast({
        title: 'Path copied',
        description: filename(path),
        variant: 'success',
      });
    } catch (e) {
      toast({
        title: 'Could not copy',
        description: String(e),
        variant: 'error',
      });
    }
  };

  /// Copy a markdown audio embed (`![label](<path>)`) for the stem.
  /// `buildAudioEmbed` wraps paths with spaces/parens in `<…>` so the
  /// CommonMark parser keeps the URL intact when pasted into a note —
  /// a plain `path` would break on the spaces in `Stash Stems/...`.
  const copyEmbed = async (path: string, stem: string) => {
    const label = STEM_LABELS[stem] ?? stem;
    const md = buildAudioEmbed(path, label);
    try {
      await navigator.clipboard.writeText(md);
      toast({
        title: 'Markdown embed copied',
        description: 'Paste into a note to get an inline audio player.',
        variant: 'success',
      });
    } catch (e) {
      toast({
        title: 'Could not copy',
        description: String(e),
        variant: 'error',
      });
    }
  };

  const toggle = () => {
    if (!expandable) return;
    setExpanded((v) => !v);
  };

  const onHeaderKey = (e: React.KeyboardEvent) => {
    if (!expandable) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  };

  // Compact summary chips for the collapsed header — gives users a
  // quick scan of "what's in this job" without expanding.
  const summary: string[] = [];
  if (job.result?.bpm != null) summary.push(`BPM ${job.result.bpm.toFixed(1)}`);
  if (job.result?.duration_sec != null) {
    const d = formatDuration(job.result.duration_sec, { empty: '' });
    if (d) summary.push(d);
  }
  if (stemEntries.length > 0) summary.push(`${stemEntries.length} stems`);

  return (
    <div
      data-testid={`done-${job.id}`}
      className={`group/row relative rounded-lg border [border-color:var(--hairline)] overflow-hidden transition-shadow hover:shadow-md hover:shadow-black/20 ${
        failed ? 'opacity-80' : ''
      }`}
      style={
        isFirst
          ? {
              background: `linear-gradient(135deg, ${accent(0.06)} 0%, transparent 60%)`,
            }
          : undefined
      }
    >
      <div
        className={`flex items-center gap-3 px-3 py-2.5 ${
          expandable ? 'cursor-pointer' : 'cursor-default'
        }`}
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : -1}
        aria-expanded={expandable ? isOpen : undefined}
        onClick={toggle}
        onKeyDown={onHeaderKey}
      >
        {expandable && (
          <Chevron
            open={isOpen}
            className="shrink-0 t-tertiary"
            aria-hidden
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="t-primary text-body truncate">{filename(job.input_path)}</div>
          <div className="text-meta opacity-60 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 mt-0.5">
            {summary.map((s) => (
              <span key={s}>{s}</span>
            ))}
            {job.result?.model && (
              <span className="opacity-70">{job.result.model}</span>
            )}
            {job.result?.device && (
              <span className="opacity-50">{job.result.device}</span>
            )}
            {failed && (
              <span className="text-red-300/80" data-testid="job-error">
                Failed
              </span>
            )}
            {cancelled && <span>Cancelled</span>}
          </div>
        </div>
        {/* Stem color dots — instant visual scan of which stems exist. */}
        {!isOpen && stemEntries.length > 0 && (
          <div
            className="hidden sm:flex items-center gap-1 shrink-0"
            aria-hidden
          >
            {stemEntries.map(([name]) => (
              <span
                key={name}
                title={STEM_LABELS[name] ?? name}
                className="w-2 h-2 rounded-full"
                style={{ background: `rgb(${stemColor(name)})` }}
              />
            ))}
          </div>
        )}
        <div
          className="flex items-center gap-1 shrink-0 opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          {job.result?.stems_dir && (
            <IconButton
              title="Open folder"
              onClick={() => revealFile(job.result!.stems_dir!)}
            >
              <ExternalIcon size={13} />
            </IconButton>
          )}
          <IconButton
            title="Remove from history"
            onClick={() => setRemoveOpen(true)}
          >
            <CloseIcon size={12} />
          </IconButton>
        </div>
      </div>

      {failed && job.error && (
        <div
          className="text-meta text-red-300/80 px-3 pb-2.5 -mt-1 truncate"
          title={job.error}
        >
          {job.error.split('\n')[0]}
        </div>
      )}

      {isOpen && (
        <div className="px-3 pb-3 pt-1 flex flex-col gap-3">
          {job.input_path.startsWith('/') && (
            // Legacy jobs reconstructed from disk don't preserve the
            // original input path — `input_path` then holds just the
            // folder name and the `<audio>` element would 404. Skip the
            // source player in that case; the stem players still work
            // because their paths are absolute.
            <div>
              <div className="text-meta opacity-50 mb-1.5 uppercase tracking-wide">
                Master
              </div>
              <AudioPlayer
                src={job.input_path}
                loader="stream"
                display="waveform"
                durationHint={job.result?.duration_sec ?? undefined}
              />
            </div>
          )}
          {stemEntries.length > 0 && (
            <div className="mb-3">
              <div className="text-meta opacity-50 mb-1.5 uppercase tracking-wide flex items-center gap-2">
                <span>Mixer</span>
                <span
                  className="flex-1 h-px"
                  style={{ background: 'var(--hairline)' }}
                />
              </div>
              <StemMixer
                jobId={job.id}
                stems={stemEntries.map(([name, path]) => ({ name, path }))}
                durationHint={job.result?.duration_sec ?? undefined}
                onReveal={(p) => revealFile(p)}
                onCopyPath={copyPath}
                onCopyEmbed={copyEmbed}
                onExtractMidi={extractStemMidi}
                midiBusy={midiBusy}
                onDelete={(path, name) => setStemDelete({ name, path })}
                beats={job.result?.beats}
                chords={chords ?? undefined}
                onDetectChords={chords ? undefined : runChordDetection}
                chordsBusy={chordsBusy}
              />
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={stemDelete !== null}
        title={
          stemDelete
            ? `Delete ${STEM_LABELS[stemDelete.name] ?? stemDelete.name} stem?`
            : ''
        }
        description={
          stemDelete
            ? `Removes the file from disk:\n${stemDelete.path}`
            : ''
        }
        confirmLabel="Delete"
        tone="danger"
        onConfirm={async () => {
          const target = stemDelete;
          setStemDelete(null);
          if (!target) return;
          try {
            await deleteStem(job.id, target.name);
          } catch (e) {
            toast({
              title: 'Delete failed',
              description: String(e),
              variant: 'error',
            });
          }
        }}
        onCancel={() => setStemDelete(null)}
      />
      <ConfirmDialog
        open={removeOpen}
        title="Delete this extraction?"
        description={
          job.result?.stems_dir
            ? `Removes the entry and deletes the stems folder from disk:\n${job.result.stems_dir}`
            : 'Removes the entry from history.'
        }
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => {
          setRemoveOpen(false);
          onRemove(job.id);
        }}
        onCancel={() => setRemoveOpen(false)}
      />
    </div>
  );
}

function Chevron({
  open,
  className,
}: {
  open: boolean;
  className?: string;
  'aria-hidden'?: boolean;
}) {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      className={`transition-transform duration-150 ${open ? 'rotate-90' : ''} ${className ?? ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function filename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}
