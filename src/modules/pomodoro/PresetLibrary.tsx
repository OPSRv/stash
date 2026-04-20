import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { EmptyState } from '../../shared/ui/EmptyState';
import { IconButton } from '../../shared/ui/IconButton';
import { TrashIcon, PencilIcon } from '../../shared/ui/icons';
import { listPresets, deletePreset, type Preset } from './api';
import { PostureBadge } from './PostureBadge';
import type { Posture } from './api';

interface PresetLibraryProps {
  onStart: (preset: Preset) => void;
  onEdit: (preset: Preset) => void;
  onNew: () => void;
}

const uniquePostures = (p: Preset): Posture[] => {
  const seen = new Set<Posture>();
  p.blocks.forEach((b) => seen.add(b.posture));
  return Array.from(seen);
};

const totalMinutes = (p: Preset) =>
  Math.round(p.blocks.reduce((s, b) => s + b.duration_sec, 0) / 60);

export const PresetLibrary = ({ onStart, onEdit, onNew }: PresetLibraryProps) => {
  const [presets, setPresets] = useState<Preset[] | null>(null);
  const [toDelete, setToDelete] = useState<Preset | null>(null);

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

  const list = presets ?? [];
  const empty = useMemo(() => list.length === 0, [list]);

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between px-3 py-2 border-b hair">
        <h2 className="t-primary text-sm font-semibold">Pomodoro presets</h2>
        <Button size="sm" onClick={onNew}>
          + New preset
        </Button>
      </header>
      <div className="flex-1 overflow-y-auto">
        {presets === null ? null : empty ? (
          <div className="p-6 flex items-center justify-center">
            <EmptyState
              title="No presets yet"
              description="Build a plan of focus + movement blocks to get started."
              action={<Button onClick={onNew}>Create your first preset</Button>}
            />
          </div>
        ) : (
          <ul className="p-3 flex flex-col gap-2">
            {list.map((p) => (
              <li
                key={p.id}
                className="flex items-center gap-3 px-3 py-2 rounded-md border hair"
              >
                <div className="flex-1 min-w-0">
                  <div className="t-primary text-body font-medium truncate">
                    {p.name}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="t-tertiary text-meta font-mono tabular-nums">
                      {p.blocks.length} blocks · {totalMinutes(p)}m
                    </span>
                    <div className="flex gap-1">
                      {uniquePostures(p).map((posture) => (
                        <PostureBadge key={posture} posture={posture} />
                      ))}
                    </div>
                  </div>
                </div>
                <Button size="sm" onClick={() => onStart(p)}>
                  Start
                </Button>
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
