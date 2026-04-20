import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { EmptyState } from '../../shared/ui/EmptyState';
import { IconButton } from '../../shared/ui/IconButton';
import { SegmentedControl } from '../../shared/ui/SegmentedControl';
import { PencilIcon, TrashIcon } from '../../shared/ui/icons';
import { deletePreset, listPresets, type Posture, type Preset, type PresetKind } from './api';
import { PostureBadge } from './PostureBadge';

interface PresetLibraryProps {
  onStart: (preset: Preset) => void;
  onEdit: (preset: Preset) => void;
  onNew: (kind: PresetKind) => void;
}

const KIND_OPTIONS: { value: PresetKind; label: string }[] = [
  { value: 'session', label: 'Session' },
  { value: 'daily', label: 'Daily' },
];

const uniquePostures = (p: Preset): Posture[] => {
  const seen = new Set<Posture>();
  p.blocks.forEach((b) => seen.add(b.posture));
  return Array.from(seen);
};

const totalMinutes = (p: Preset) =>
  Math.round(p.blocks.reduce((s, b) => s + b.duration_sec, 0) / 60);

const kindCopy: Record<PresetKind, { title: string; subtitle: string; empty: string }> = {
  session: {
    title: 'Sessions',
    subtitle: 'One-shot runs — 20–45 min.',
    empty: 'No session presets yet. A "session" is one short block — hit go and walk away.',
  },
  daily: {
    title: 'Daily plans',
    subtitle: 'Multi-block flows for a working block of the day.',
    empty: 'No daily plans yet. Compose a sequence of sit / stand / walk blocks to run back-to-back.',
  },
};

export const PresetLibrary = ({ onStart, onEdit, onNew }: PresetLibraryProps) => {
  const [presets, setPresets] = useState<Preset[] | null>(null);
  const [toDelete, setToDelete] = useState<Preset | null>(null);
  const [filter, setFilter] = useState<PresetKind>('session');

  const reload = useCallback(() => {
    listPresets()
      .then(setPresets)
      .catch((e) => {
        console.error('list presets failed', e);
        setPresets([]);
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const confirmDelete = useCallback(async () => {
    if (!toDelete) return;
    try {
      await deletePreset(toDelete.id);
    } finally {
      setToDelete(null);
      reload();
    }
  }, [toDelete, reload]);

  const filtered = useMemo(
    () => (presets ?? []).filter((p) => p.kind === filter),
    [presets, filter],
  );
  const empty = filtered.length === 0;
  const copy = kindCopy[filter];

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between gap-3 px-4 py-3 border-b hair">
        <div>
          <div className="section-label">Pomodoro library</div>
          <h2 className="t-primary text-heading font-medium tracking-tight">
            {copy.title}
          </h2>
          <p className="t-tertiary text-meta mt-0.5">{copy.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <SegmentedControl<PresetKind>
            size="sm"
            value={filter}
            onChange={setFilter}
            options={KIND_OPTIONS}
            ariaLabel="Preset kind filter"
          />
          <Button size="sm" onClick={() => onNew(filter)}>
            + New {filter}
          </Button>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto">
        {presets === null ? null : empty ? (
          <div className="p-8 flex items-center justify-center">
            <EmptyState
              title={copy.title}
              description={copy.empty}
              action={
                <Button onClick={() => onNew(filter)}>
                  Create your first {filter}
                </Button>
              }
            />
          </div>
        ) : (
          <ul className="p-4 grid grid-cols-2 gap-3">
            {filtered.map((p) => (
              <li
                key={p.id}
                className="group relative flex flex-col gap-3 p-3.5 rounded-xl border hair transition-colors"
                style={{ background: 'rgba(255,255,255,0.02)' }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="t-primary text-title font-medium truncate">
                      {p.name}
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="t-tertiary text-meta font-mono tabular-nums">
                        {p.blocks.length} {p.blocks.length === 1 ? 'block' : 'blocks'}
                      </span>
                      <span className="t-tertiary text-meta">·</span>
                      <span className="t-secondary text-meta font-mono tabular-nums">
                        {totalMinutes(p)}m
                      </span>
                    </div>
                  </div>
                  <div className="flex opacity-0 group-hover:opacity-100 transition-opacity">
                    <IconButton onClick={() => onEdit(p)} title="Edit preset">
                      <PencilIcon size={12} />
                    </IconButton>
                    <IconButton
                      onClick={() => setToDelete(p)}
                      title="Delete preset"
                      tone="danger"
                    >
                      <TrashIcon size={12} />
                    </IconButton>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {uniquePostures(p).map((posture) => (
                    <PostureBadge key={posture} posture={posture} />
                  ))}
                </div>
                <Button size="sm" onClick={() => onStart(p)} fullWidth>
                  Start {p.name}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConfirmDialog
        open={toDelete !== null}
        title={`Delete "${toDelete?.name ?? ''}"?`}
        description="The preset will be removed. Sessions you already started keep their own copy."
        confirmLabel="Delete"
        tone="danger"
        onConfirm={confirmDelete}
        onCancel={() => setToDelete(null)}
      />
    </div>
  );
};
