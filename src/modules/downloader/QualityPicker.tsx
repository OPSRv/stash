import { Kbd } from '../../shared/ui/Kbd';
import { formatBytes, type QualityOption } from './api';

interface QualityPickerProps {
  options: QualityOption[];
  selected: QualityOption | null;
  onSelect: (option: QualityOption) => void;
  onDownload: () => void;
}

const downloadButtonStyle = {
  background: 'rgba(var(--stash-accent-rgb), 0.9)',
  boxShadow:
    '0 1px 0 rgba(0,0,0,0.25), inset 0 0.5px 0 rgba(255,255,255,0.18)',
} as const;

export const QualityPicker = ({
  options,
  selected,
  onSelect,
  onDownload,
}: QualityPickerProps) => (
  <>
    <div className="seg flex text-meta font-medium shrink-0">
      {options.map((q) => (
        <button
          key={q.format_id}
          onClick={() => onSelect(q)}
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
    <button
      onClick={onDownload}
      disabled={!selected}
      className="px-3.5 py-2 rounded-lg text-body font-medium text-white flex items-center gap-1.5"
      style={downloadButtonStyle}
    >
      Download <Kbd>↵</Kbd>
    </button>
  </>
);
