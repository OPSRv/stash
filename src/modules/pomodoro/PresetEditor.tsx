import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { Input } from '../../shared/ui/Input';
import { SegmentedControl } from '../../shared/ui/SegmentedControl';
import { BlockRow } from './BlockRow';
import type { Block, Preset, PresetKind } from './api';

interface PresetEditorProps {
  /** Existing preset to edit. `null` means a brand-new draft. */
  initial: Preset | null;
  /** Default kind when opening a fresh editor from the Session/Daily filter. */
  defaultKind?: PresetKind;
  onSave: (name: string, kind: PresetKind, blocks: Block[]) => void;
  onStartWithoutSaving: (blocks: Block[]) => void;
  onCancel: () => void;
}

const KIND_OPTIONS: { value: PresetKind; label: string }[] = [
  { value: 'session', label: 'Session' },
  { value: 'daily', label: 'Daily' },
];

let nextBlockSeq = 0;
const makeId = () => `b_${Date.now().toString(36)}_${(nextBlockSeq++).toString(36)}`;

const DEFAULT_BLOCK = (): Block => ({
  id: makeId(),
  name: 'Focus',
  duration_sec: 25 * 60,
  posture: 'sit',
  mid_nudge_sec: null,
});

export const PresetEditor = ({
  initial,
  defaultKind = 'session',
  onSave,
  onStartWithoutSaving,
  onCancel,
}: PresetEditorProps) => {
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState<PresetKind>(initial?.kind ?? defaultKind);
  const [blocks, setBlocks] = useState<Block[]>(
    initial?.blocks ?? [DEFAULT_BLOCK()],
  );

  useEffect(() => {
    setName(initial?.name ?? '');
    setKind(initial?.kind ?? defaultKind);
    setBlocks(initial?.blocks ?? [DEFAULT_BLOCK()]);
  }, [initial, defaultKind]);

  const updateBlock = useCallback((idx: number, next: Block) => {
    setBlocks((prev) => prev.map((b, i) => (i === idx ? next : b)));
  }, []);

  const deleteBlock = useCallback((idx: number) => {
    setBlocks((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
  }, []);

  const addBlock = useCallback(() => {
    setBlocks((prev) => [...prev, DEFAULT_BLOCK()]);
  }, []);

  const totalMinutes = Math.round(
    blocks.reduce((s, b) => s + b.duration_sec, 0) / 60,
  );

  const canSave = name.trim().length > 0 && blocks.length > 0;

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center gap-3 px-4 py-3 border-b hair">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={
            kind === 'session'
              ? 'Session name (e.g. Quick focus)'
              : 'Daily plan name (e.g. Standard day)'
          }
          aria-label="Preset name"
          className="flex-1"
        />
        <SegmentedControl<PresetKind>
          size="sm"
          value={kind}
          onChange={setKind}
          options={KIND_OPTIONS}
          ariaLabel="Preset kind"
        />
        <span className="t-tertiary text-meta font-mono tabular-nums shrink-0 shrink-0">
          {totalMinutes}m · {blocks.length} blocks
        </span>
      </header>
      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
        {blocks.map((b, i) => (
          <BlockRow
            key={b.id}
            block={b}
            onChange={(next) => updateBlock(i, next)}
            onDelete={() => deleteBlock(i)}
          />
        ))}
        <Button variant="ghost" onClick={addBlock} className="self-start">
          + Add block
        </Button>
      </div>
      <footer className="flex items-center justify-end gap-2 px-3 py-2 border-t hair">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="soft"
          onClick={() => onStartWithoutSaving(blocks)}
          disabled={blocks.length === 0}
        >
          Start without saving
        </Button>
        <Button
          onClick={() => onSave(name.trim(), kind, blocks)}
          disabled={!canSave}
        >
          Save preset
        </Button>
      </footer>
    </div>
  );
};
