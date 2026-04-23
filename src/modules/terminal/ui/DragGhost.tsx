import type { DropPosition } from '../types';

/// Floating pill that follows the pointer during a drag. Accent when
/// hovering a valid drop target so the user knows a release here
/// lands it; muted otherwise. Renders above everything (z-index 5000)
/// and ignores pointer events so it never interferes with hit-testing.
export const DragGhost = ({
  x,
  y,
  label,
  zone,
  hasTarget,
}: {
  x: number;
  y: number;
  label: string;
  zone: DropPosition;
  hasTarget: boolean;
}) => (
  <div
    style={{
      position: 'fixed',
      left: x + 12,
      top: y + 12,
      pointerEvents: 'none',
      zIndex: 5000,
      padding: '4px 8px',
      borderRadius: 6,
      fontSize: 11,
      background: hasTarget
        ? 'var(--stash-accent)'
        : 'var(--color-bg-elev, #2a2a30)',
      color: hasTarget
        ? 'var(--color-text-on-accent, #fff)'
        : 'var(--color-text-primary, #e7e7ea)',
      boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
      whiteSpace: 'nowrap',
    }}
  >
    {label}
    {hasTarget && zone !== 'center' && (
      <span style={{ marginLeft: 6, opacity: 0.75 }}>· {zone}</span>
    )}
  </div>
);
