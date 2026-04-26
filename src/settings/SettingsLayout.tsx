import type { ReactNode } from 'react';
import { SettingsSectionHeader } from './SettingsSectionHeader';

/// Single max-width column shared by every Settings tab. Centralising it
/// here keeps every tab visually identical when the user switches —
/// before this, tabs hand-rolled `max-w-[560px] mx-auto space-y-6` and a
/// few drifted (Notes was 720, About was unconstrained).
export const SettingsTab = ({ children }: { children: ReactNode }) => (
  <div className="max-w-[560px] mx-auto space-y-6">{children}</div>
);

interface SettingsSectionProps {
  label: string;
  children: ReactNode;
  /// Opt out of the row divider for sections that lay out their own
  /// content (e.g. accent swatches, embedded panels with their own list).
  divided?: boolean;
}

/// `<section>` with the uppercase header + hairline, plus a row container
/// whose dividers work in both themes (the bare `divide-white/5` that
/// most tabs used was invisible on light theme).
export const SettingsSection = ({
  label,
  children,
  divided = true,
}: SettingsSectionProps) => (
  <section>
    <SettingsSectionHeader label={label} />
    {divided ? (
      <div className="divide-y divide-white/5 [.light_&]:divide-black/5">
        {children}
      </div>
    ) : (
      children
    )}
  </section>
);
