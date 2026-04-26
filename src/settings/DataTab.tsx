import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '../shared/ui/Button';
import { ytDlpVersion } from '../modules/downloader/api';
import { BackupSection } from './BackupSection';
import { SettingRow } from './SettingRow';
import { SettingsSection, SettingsTab } from './SettingsLayout';

/// Hosts everything data/state-related: import/export of every module's
/// store + diagnostics (data folder, log collection). Keeps About lean —
/// About is for "what is this app" only.
export const DataTab = () => {
  const [ytVersion, setYtVersion] = useState<string | null>(null);
  const [sentReport, setSentReport] = useState<string | null>(null);

  useEffect(() => {
    ytDlpVersion()
      .then((v) => setYtVersion(v.installed))
      .catch(() => {});
  }, []);

  const openDataFolder = async () => {
    try {
      await invoke('open_data_folder');
    } catch (e) {
      console.error('open data folder failed', e);
    }
  };

  const sendLogs = async () => {
    try {
      const path = await invoke<string>('collect_logs');
      setSentReport(path);
    } catch (e) {
      console.error('collect logs failed', e);
    }
  };

  return (
    <SettingsTab>
      <BackupSection />

      <SettingsSection label="DIAGNOSTICS">
        <SettingRow
          title="Data folder"
          description="Reveal the on-disk app-support directory: SQLite stores, attachments, settings file."
          control={
            <Button size="sm" onClick={openDataFolder}>
              Open…
            </Button>
          }
        />
        <SettingRow
          title="Collect logs"
          description={
            sentReport
              ? `Saved to ${sentReport}`
              : 'Bundles recent logs into a zip you can attach to a bug report.'
          }
          control={
            <Button size="sm" onClick={sendLogs}>
              Collect
            </Button>
          }
        />
        <SettingRow
          title="yt-dlp version"
          description="Currently installed yt-dlp binary. Update from the Downloads tab."
          control={
            <span className="t-tertiary text-meta font-mono tabular-nums">
              {ytVersion ?? '—'}
            </span>
          }
        />
      </SettingsSection>
    </SettingsTab>
  );
};
