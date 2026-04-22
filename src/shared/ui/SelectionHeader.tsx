import type { ReactNode } from 'react';
import { Checkbox } from './Checkbox';

type SelectionHeaderProps = {
  /// Total number of rows the header governs.
  total: number;
  /// Number of currently selected rows. `0` → unchecked header; equal to
  /// `total` → fully checked; anything in between → indeterminate.
  selected: number;
  /// Called when the user toggles the header. `true` = select all, `false`
  /// = clear selection. Consumers decide whether "select all" includes
  /// filtered-out rows.
  onToggleAll: (next: boolean) => void;
  /// Label to the right of the checkbox (usually the collection name).
  label?: ReactNode;
  /// Right-aligned slot for extra controls (sort dropdown, actions).
  trailing?: ReactNode;
  /// When `true`, the row renders a top border and some padding so it can
  /// sit directly on top of a list without a wrapping header element.
  separated?: boolean;
  className?: string;
};

/// Header row for selectable lists. Pairs a tri-state checkbox with a
/// "N of M selected" counter. Before this primitive each system panel
/// re-implemented the same 20-line block (`CachesPanel`, `NodeModulesPanel`,
/// `SmartScanPanel`), each with slightly different wording.
export const SelectionHeader = ({
  total,
  selected,
  onToggleAll,
  label,
  trailing,
  separated = false,
  className = '',
}: SelectionHeaderProps) => {
  const allOn = total > 0 && selected === total;
  const someOn = selected > 0 && !allOn;
  const counter =
    selected === 0
      ? `${total} item${total === 1 ? '' : 's'}`
      : `${selected} of ${total} selected`;

  const base = [
    'flex items-center gap-3 px-3 py-2',
    separated ? 'border-b hair' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={base}>
      <Checkbox
        size="sm"
        checked={allOn}
        indeterminate={someOn}
        onChange={(next) => onToggleAll(next)}
        ariaLabel={allOn ? 'Clear selection' : 'Select all'}
      />
      <div className="flex-1 min-w-0 t-secondary text-meta flex items-center gap-2">
        {label != null && <span className="t-primary font-medium">{label}</span>}
        <span className="t-tertiary tabular-nums">{counter}</span>
      </div>
      {trailing}
    </div>
  );
};
