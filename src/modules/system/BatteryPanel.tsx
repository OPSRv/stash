import { useEffect, useState } from 'react';
import { Spinner } from '../../shared/ui/Spinner';
import { EmptyState } from '../../shared/ui/EmptyState';
import { batteryHealth, type BatteryHealth } from './api';

const StatCard = ({
  label,
  value,
  tint,
}: {
  label: string;
  value: string;
  tint: [string, string];
}) => (
  <div
    className="rounded-2xl p-3 min-w-0 relative overflow-hidden"
    style={{
      background: `linear-gradient(135deg, ${tint[0]}20, ${tint[1]}30)`,
      boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06)',
    }}
  >
    <div
      aria-hidden
      className="absolute -top-6 -right-4 w-20 h-20 rounded-full"
      style={{
        background: `radial-gradient(closest-side, ${tint[1]}50, transparent)`,
        filter: 'blur(6px)',
      }}
    />
    <div className="relative">
      <div className="t-tertiary text-[10px] uppercase tracking-wider">{label}</div>
      <div className="t-primary text-title font-semibold mt-1">{value}</div>
    </div>
  </div>
);

export const BatteryPanel = () => {
  const [h, setH] = useState<BatteryHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    batteryHealth().then(setH).catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="p-4 t-danger">Error: {error}</div>;
  if (!h) return <div className="flex items-center justify-center h-full"><Spinner /></div>;
  if (!h.present)
    return (
      <EmptyState
        title="Battery not found"
        description="This is likely a desktop — data unavailable."
      />
    );

  const capacityPct =
    h.max_capacity_mah !== null && h.design_capacity_mah
      ? Math.round((h.max_capacity_mah / h.design_capacity_mah) * 100)
      : null;

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      <header>
        <div className="t-primary text-title font-semibold">Battery health</div>
        <div className="t-tertiary text-meta">
          Data from `system_profiler SPPowerDataType` — updated by macOS at its discretion.
        </div>
      </header>

      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}
      >
        <StatCard
          label="Condition"
          value={h.condition ?? '—'}
          tint={['#7ef7a5', '#17b26a']}
        />
        <StatCard
          label="Cycles"
          value={h.cycle_count !== null ? h.cycle_count.toString() : '—'}
          tint={['#8ec5ff', '#5561ff']}
        />
        <StatCard
          label="Current capacity"
          value={h.current_capacity_mah !== null ? `${h.current_capacity_mah} mAh` : '—'}
          tint={['#ffd86b', '#ff914d']}
        />
        <StatCard
          label="Max capacity"
          value={
            capacityPct !== null
              ? `${capacityPct}%`
              : h.max_capacity_mah !== null
              ? `${h.max_capacity_mah} mAh`
              : '—'
          }
          tint={['#5ee2c4', '#2aa3ff']}
        />
      </div>

      <div className="t-tertiary text-meta">
        Tip: when cycle count exceeds 1000 or condition shows "Service Recommended" —
        it's time to plan a replacement.
      </div>
    </div>
  );
};
