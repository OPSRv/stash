import { EmptyState } from '../../shared/ui/EmptyState';

/// Placeholder for the upcoming display-management sub-tab (brightness,
/// power on/off per connected monitor). Kept as a distinct component so
/// the SystemShell routing already has its slot — we just swap the body
/// when the Rust side lands.
export const DisplaysPanel = () => (
  <div className="flex-1 flex items-center justify-center">
    <EmptyState
      title="Керування екранами"
      description="Яскравість і вимкнення підключених моніторів будуть доступні тут. У роботі."
    />
  </div>
);
