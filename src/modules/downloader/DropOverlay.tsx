const overlayStyle = {
  background: 'rgba(var(--stash-accent-rgb),0.12)',
  border: '2px dashed rgba(var(--stash-accent-rgb),0.6)',
  borderRadius: 'var(--radius-lg)',
} as const;

export const DropOverlay = () => (
  <div
    className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none"
    style={overlayStyle}
  >
    <div className="t-primary text-title font-medium">Drop URL to download</div>
  </div>
);
