import { Input } from '../../shared/ui/Input';
import { IconButton } from '../../shared/ui/IconButton';
import { SegmentedControl } from '../../shared/ui/SegmentedControl';
import { Toggle } from '../../shared/ui/Toggle';
import { TrashIcon } from '../../shared/ui/icons';
import type { Block, Posture } from './api';
import { DEFAULT_MID_NUDGE_SEC } from './constants';
import { PostureBadge } from './PostureBadge';

interface BlockRowProps {
  block: Block;
  onChange: (next: Block) => void;
  onDelete: () => void;
  readOnly?: boolean;
}

const POSTURE_OPTIONS: { value: Posture; label: string }[] = [
  { value: 'sit', label: '💺 Sit' },
  { value: 'stand', label: '🧍 Stand' },
  { value: 'walk', label: '🚶 Walk' },
];

const clampMinutes = (raw: string) => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(240, Math.round(n));
};

export const BlockRow = ({ block, onChange, onDelete, readOnly = false }: BlockRowProps) => {
  if (readOnly) {
    return (
      <div className="flex items-center gap-3 px-3 py-2 rounded-md border hair">
        <PostureBadge posture={block.posture} />
        <div className="flex-1 min-w-0 t-primary text-body truncate">{block.name}</div>
        <span className="t-tertiary text-meta font-mono tabular-nums">
          {Math.round(block.duration_sec / 60)}m
        </span>
      </div>
    );
  }

  const nudgeEnabled = block.mid_nudge_sec != null;
  const nudgeMinutes = block.mid_nudge_sec != null ? Math.round(block.mid_nudge_sec / 60) : Math.round(DEFAULT_MID_NUDGE_SEC / 60);

  return (
    <div className="flex flex-col gap-2 px-3 py-2.5 rounded-md border hair">
      <div className="flex items-center gap-2">
        <Input
          size="sm"
          value={block.name}
          onChange={(e) => onChange({ ...block, name: e.target.value })}
          placeholder="Block name"
          className="flex-1"
          aria-label="Block name"
        />
        <Input
          size="sm"
          type="number"
          min={1}
          max={240}
          value={Math.max(1, Math.round(block.duration_sec / 60))}
          onChange={(e) =>
            onChange({ ...block, duration_sec: clampMinutes(e.target.value) * 60 })
          }
          className="w-16"
          aria-label="Duration in minutes"
          trailing={<span className="t-tertiary text-[11px] pr-1">m</span>}
        />
        <IconButton onClick={onDelete} title="Remove block" tone="danger">
          <TrashIcon size={12} />
        </IconButton>
      </div>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <SegmentedControl<Posture>
          size="sm"
          value={block.posture}
          onChange={(v) => onChange({ ...block, posture: v })}
          options={POSTURE_OPTIONS}
          ariaLabel="Posture"
        />
        <label className="flex items-center gap-2 t-secondary text-meta">
          <Toggle
            checked={nudgeEnabled}
            onChange={(next) =>
              onChange({
                ...block,
                mid_nudge_sec: next ? nudgeMinutes * 60 : null,
              })
            }
            label="Mid-block nudge"
          />
          Nudge at
          <Input
            size="sm"
            type="number"
            min={1}
            max={240}
            disabled={!nudgeEnabled}
            value={nudgeMinutes}
            onChange={(e) =>
              onChange({
                ...block,
                mid_nudge_sec: clampMinutes(e.target.value) * 60,
              })
            }
            className="w-14"
            aria-label="Nudge threshold in minutes"
            trailing={<span className="t-tertiary text-[11px] pr-1">m</span>}
          />
        </label>
      </div>
    </div>
  );
};
