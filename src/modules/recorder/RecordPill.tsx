interface RecordPillProps {
  onClick: () => void;
}

/// Big record-call-to-action shown when no recording is in progress.
/// Extracted from RecorderShell to keep one-component-per-file.
export const RecordPill = ({ onClick }: RecordPillProps) => (
  <button
    onClick={onClick}
    className="flex items-center gap-2 pr-3 pl-1 py-1 rounded-full"
    style={{
      background: 'rgba(235,72,72,0.14)',
      border: '1px solid rgba(235,72,72,0.32)',
    }}
  >
    <span
      className="w-6 h-6 rounded-full flex items-center justify-center rec-dot"
      style={{ background: '#EB4848' }}
    >
      <span className="w-2.5 h-2.5 rounded-full bg-white/85" />
    </span>
    <span className="text-body font-medium" style={{ color: '#FF7878' }}>
      Record
    </span>
  </button>
);
