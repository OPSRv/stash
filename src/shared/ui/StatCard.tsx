import type { ReactNode } from 'react';

type StatCardProps = {
  /// Two-stop gradient that sets the card's background wash and icon tile
  /// tint. Same pair is re-used for shadow and decorative blob so one card
  /// only picks two colours.
  gradient: [string, string];
  /// 24×24-ish SVG rendered inside a 40×40 rounded tile. Stroke should be
  /// `currentColor` — the tile forces `text-white` for contrast.
  icon?: ReactNode;
  /// Small uppercase tag above the primary value (e.g. `WI-FI`, `Wi-Fi`).
  eyebrow?: ReactNode;
  /// The big number. `tabular-nums` is applied for you.
  value: ReactNode;
  /// Secondary text under the value (unit, trend).
  hint?: ReactNode;
  /// Optional top-right slot for a sparkline / mini-chart / badge.
  trailing?: ReactNode;
  /// Optional footer slot for richer data (two rates side-by-side, etc).
  footer?: ReactNode;
  className?: string;
};

/// Generic dashboard card. Before this component each panel in
/// `DashboardPanel` / `BatteryPanel` / `NetworkPanel` re-implemented the
/// same gradient-washed layout with a glyph tile + big number + hint.
export const StatCard = ({
  gradient,
  icon,
  eyebrow,
  value,
  hint,
  trailing,
  footer,
  className = '',
}: StatCardProps) => {
  const [from, to] = gradient;
  return (
    <div
      className={`rounded-2xl p-3 relative overflow-hidden ${className}`}
      style={{
        background: `linear-gradient(135deg, ${from}1c, ${to}2e)`,
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.07)',
      }}
    >
      <div
        aria-hidden
        className="absolute -top-6 -right-6 w-24 h-24 rounded-full"
        style={{
          background: `radial-gradient(closest-side, ${to}55, transparent)`,
          filter: 'blur(6px)',
        }}
      />
      <div className="relative flex items-start gap-3">
        {icon && (
          <div
            aria-hidden
            className="shrink-0 w-10 h-10 rounded-xl inline-flex items-center justify-center text-white"
            style={{
              background: `linear-gradient(135deg, ${from}, ${to})`,
              boxShadow: `0 6px 18px -6px ${to}, inset 0 0 0 1px rgba(255,255,255,0.2)`,
            }}
          >
            {icon}
          </div>
        )}
        <div className="min-w-0 flex-1">
          {eyebrow != null && (
            <div className="t-tertiary text-meta uppercase tracking-wider">
              {eyebrow}
            </div>
          )}
          <div className="t-primary text-title font-semibold tabular-nums">
            {value}
          </div>
          {hint != null && (
            <div className="t-tertiary text-meta truncate">{hint}</div>
          )}
        </div>
        {trailing != null && <div className="shrink-0">{trailing}</div>}
      </div>
      {footer != null && <div className="relative mt-2">{footer}</div>}
    </div>
  );
};
