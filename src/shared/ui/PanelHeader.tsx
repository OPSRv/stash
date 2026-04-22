import type { ReactNode } from 'react';

/// Parse `#rrggbb` (6-digit) into `r,g,b` — good enough for the
/// compile-time palette literals we pass in; not meant for user input.
const hexToRgb = (hex: string): string => {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r},${g},${b}`;
};

type PanelHeaderProps = {
  /// Two hex stops that define the icon tile's linear gradient. The outer
  /// header wash and decorative blob are derived from these same stops at
  /// reduced opacity, so every panel only picks two colours.
  gradient: [string, string];
  /// 24×24 SVG rendered inside a 56×56 rounded tile. Stroke should be
  /// `currentColor` — the tile sets `text-white` for contrast against the
  /// gradient.
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /// Right-aligned slot for the "total size + refresh" controls. Laid out
  /// as a vertical stack (`flex-col items-end gap-1.5`) so the larger total
  /// sits above the button like every panel used to render by hand.
  trailing?: ReactNode;
  /// Extra content rendered to the right of the description area but before
  /// `trailing` — used by DiskHogsPanel for its inline SegmentedControl.
  inlineRight?: ReactNode;
};

/// Unified gradient header used by every system panel (Caches, NodeModules,
/// DiskHogs, SmartScan, LargeFiles, TrashBins, Duplicates, Privacy, …).
/// Before this component each panel re-implemented the same 40-line layout
/// with slightly different colours.
export const PanelHeader = ({
  gradient,
  icon,
  title,
  description,
  trailing,
  inlineRight,
}: PanelHeaderProps) => {
  const [from, to] = gradient;
  const fromRgb = hexToRgb(from);
  const toRgb = hexToRgb(to);
  return (
    <header
      className="px-4 py-3 relative overflow-hidden"
      style={{
        background: `linear-gradient(135deg, rgba(${fromRgb},0.14), rgba(${toRgb},0.18))`,
        boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.06)',
      }}
    >
      <div
        aria-hidden
        className="absolute -top-12 -right-8 w-40 h-40 rounded-full"
        style={{
          background: `radial-gradient(closest-side, rgba(${toRgb},0.38), transparent)`,
          filter: 'blur(10px)',
        }}
      />
      <div className="relative flex items-center gap-4">
        <div
          aria-hidden
          className="w-14 h-14 rounded-2xl inline-flex items-center justify-center shrink-0 text-white"
          style={{
            background: `linear-gradient(135deg,${from},${to})`,
            boxShadow: `0 8px 24px -8px rgba(${toRgb},0.55), inset 0 0 0 1px rgba(255,255,255,0.2)`,
          }}
        >
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="t-primary text-title font-semibold">{title}</div>
          {description && (
            <div className="t-tertiary text-meta truncate">{description}</div>
          )}
        </div>
        {inlineRight}
        {trailing && (
          <div className="flex flex-col items-end gap-1.5 shrink-0">{trailing}</div>
        )}
      </div>
    </header>
  );
};
