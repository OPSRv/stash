interface SettingsSectionHeaderProps {
  label: string;
}

/// Uppercase section label with a trailing hairline divider. Used by the
/// Appearance tab to delimit THEME / ACCENT / SURFACE groups.
export const SettingsSectionHeader = ({ label }: SettingsSectionHeaderProps) => (
  <div className="flex items-baseline gap-3 mb-3 mt-1">
    <span className="screen-label">{label}</span>
    <span className="hair h-px flex-1" />
  </div>
);
