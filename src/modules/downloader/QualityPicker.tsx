import { Kbd } from '../../shared/ui/Kbd';
import { Button } from '../../shared/ui/Button';
import { formatBytes, type QualityOption } from './api';

interface QualityPickerProps {
  options: QualityOption[];
  selected: QualityOption | null;
  onSelect: (option: QualityOption) => void;
  onDownload: () => void;
}

export const QualityPicker = ({
  options,
  selected,
  onSelect,
  onDownload,
}: QualityPickerProps) => (
  <>
    <div className="seg flex flex-wrap text-meta font-medium" role="group" aria-label="Quality">
      {options.map((q) => (
        <button
          key={q.format_id}
          type="button"
          onClick={() => onSelect(q)}
          aria-pressed={selected?.format_id === q.format_id}
          className={`px-2.5 py-1 rounded-md ${
            selected?.format_id === q.format_id ? 'on' : ''
          }`}
        >
          {q.label}
          {q.est_size && (
            <span className="t-tertiary text-[10px] ml-1">{formatBytes(q.est_size)}</span>
          )}
        </button>
      ))}
    </div>
    <Button
      variant="solid"
      tone="accent"
      onClick={onDownload}
      disabled={!selected}
      trailingIcon={<Kbd>↵</Kbd>}
    >
      Download
    </Button>
  </>
);
