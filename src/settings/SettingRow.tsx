import type { ReactNode } from 'react';

interface SettingRowProps {
  title: string;
  description?: string;
  control: ReactNode;
}

/// A single row in a Settings tab: left title + optional description,
/// right-aligned control. Consistent spacing so tabs feel uniform.
export const SettingRow = ({ title, description, control }: SettingRowProps) => (
  <div className="flex items-center justify-between gap-4 py-3">
    <div className="flex-1 min-w-0">
      <div className="t-primary text-body font-medium">{title}</div>
      {description && <div className="t-tertiary text-meta">{description}</div>}
    </div>
    <div className="shrink-0">{control}</div>
  </div>
);
