import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Button } from '../shared/ui/Button';
import { Toggle } from '../shared/ui/Toggle';
import { SettingRow } from './SettingRow';
import { SettingsSection } from './SettingsLayout';

interface WindowSectionProps {
  autostartOn: boolean;
  onToggleAutostart: (next: boolean) => void;
}

/// Window-behaviour rows: launch-at-login + popup position. Lives under
/// General because both shape *how* the window appears, not the look of
/// it (theme/accent stay in Appearance).
export const WindowSection = ({ autostartOn, onToggleAutostart }: WindowSectionProps) => {
  const [posMoved, setPosMoved] = useState(false);

  useEffect(() => {
    invoke<boolean>('popup_position_status').then(setPosMoved).catch(() => {});
    const unlistenPromise = listen<boolean>('popup:position_changed', (e) =>
      setPosMoved(e.payload),
    );
    return () => {
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, []);

  return (
    <SettingsSection label="WINDOW">
      <SettingRow
        title="Launch at login"
        description="Starts Stash quietly in the menubar when you log in."
        control={
          <Toggle
            checked={autostartOn}
            onChange={onToggleAutostart}
            label="Launch at login"
          />
        }
      />
      <SettingRow
        title="Position"
        description={
          posMoved
            ? 'Custom position — pinned where you dropped it. Reset to snap back under the tray icon.'
            : 'Follows the menubar icon. Drag the popup by its tab header to pin it anywhere.'
        }
        control={
          <Button
            size="sm"
            disabled={!posMoved}
            onClick={() => {
              invoke('popup_position_reset').catch(() => {});
            }}
          >
            Reset position
          </Button>
        }
      />
    </SettingsSection>
  );
};
