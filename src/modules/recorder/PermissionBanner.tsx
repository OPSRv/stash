import { invoke } from '@tauri-apps/api/core';
import { Button } from '../../shared/ui/Button';

export type PermissionPane = 'screen-recording' | 'microphone' | 'camera';

interface PermissionBannerProps {
  pane: PermissionPane;
  label: string;
}

export const PermissionBanner = ({ pane, label }: PermissionBannerProps) => (
  <div
    className="rounded-md px-3 py-2 text-meta flex items-center justify-between gap-3"
    style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
  >
    <span>{label}</span>
    <Button
      size="sm"
      variant="soft"
      onClick={() => invoke('open_system_settings', { pane }).catch(() => {})}
    >
      Open Settings
    </Button>
  </div>
);
