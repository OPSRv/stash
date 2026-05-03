import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Button } from '../shared/ui/Button';
import { Input } from '../shared/ui/Input';
import { NumberInput } from '../shared/ui/NumberInput';
import { Toggle } from '../shared/ui/Toggle';
import { SettingRow } from './SettingRow';
import { SettingsSection, SettingsTab } from './SettingsLayout';
import { YtDlpUpdateRow } from './YtDlpUpdateRow';
import type { Settings } from './store';

/// yt-dlp `-r` accepts a bare byte-count, optionally suffixed with
/// `K`/`M`/`G` (binary units). Empty/null = unlimited. We reject anything
/// else up front so the download doesn't silently fail with a cryptic
/// yt-dlp error at runtime.
const RATE_LIMIT_RE = /^\d+(\.\d+)?[KMG]?$/;
const isInvalidRateLimit = (raw: string | null): boolean => {
  if (!raw) return false;
  return !RATE_LIMIT_RE.test(raw);
};

interface DownloadsTabProps {
  settings: Settings;
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

export const DownloadsTab = ({ settings, onChange }: DownloadsTabProps) => {
  const pickFolder = async () => {
    // Popup hides on blur; suspend that while the native modal is up so
    // taking focus for the folder picker does not dismiss it.
    await invoke('set_popup_auto_hide', { enabled: false }).catch(() => {});
    try {
      const selected = await openDialog({ directory: true, multiple: false });
      if (typeof selected === 'string') onChange('downloadsFolder', selected);
    } catch (e) {
      console.error('folder pick failed', e);
    } finally {
      await invoke('set_popup_auto_hide', { enabled: true }).catch(() => {});
    }
  };

  return (
    <SettingsTab>
      <SettingsSection label="BINARY">
        <YtDlpUpdateRow />
      </SettingsSection>

      <SettingsSection label="STORAGE">
        <SettingRow
          title="Download folder"
          description={settings.downloadsFolder ?? 'Default: ~/Movies/Stash'}
          control={
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={pickFolder}>
                Choose…
              </Button>
              {settings.downloadsFolder && (
                <Button size="sm" tone="neutral" onClick={() => onChange('downloadsFolder', null)}>
                  Reset
                </Button>
              )}
            </div>
          }
        />
        <SettingRow
          title="Max parallel downloads"
          description="Extra jobs wait in a queue and start as slots free up."
          control={
            <NumberInput
              size="sm"
              ariaLabel="Max parallel downloads"
              min={1}
              max={10}
              value={settings.maxParallelDownloads}
              onChange={(v) =>
                onChange('maxParallelDownloads', Math.max(1, Math.min(10, v ?? 1)))
              }
              className="w-24"
            />
          }
        />
        <SettingRow
          title="Bandwidth limit"
          description='yt-dlp rate syntax: "500K", "2M", "1.5M". Empty = unlimited.'
          control={
            <Input
              size="sm"
              aria-label="Bandwidth limit"
              placeholder="unlimited"
              value={settings.downloadRateLimit ?? ''}
              onChange={(e) =>
                onChange(
                  'downloadRateLimit',
                  (e.currentTarget.value.trim() || null) as string | null,
                )
              }
              invalid={isInvalidRateLimit(settings.downloadRateLimit)}
              maxLength={16}
              spellCheck={false}
              autoCapitalize="off"
              className="w-24"
            />
          }
        />
        <SettingRow
          title="History retention"
          description="Days before completed/failed jobs vanish from the Downloads list (files are not removed)."
          control={
            <NumberInput
              size="sm"
              ariaLabel="History retention days"
              min={1}
              max={365}
              value={settings.historyRetentionDays}
              onChange={(v) =>
                onChange('historyRetentionDays', Math.max(1, Math.min(365, v ?? 60)))
              }
              suffix="d"
              className="w-28"
            />
          }
        />
      </SettingsSection>

      <SettingsSection label="NOTIFICATIONS">
        <SettingRow
          title="Notify when a download finishes"
          description="Shows a system notification on completion and failure."
          control={
            <Toggle
              checked={settings.notifyOnDownloadComplete}
              onChange={(v) => onChange('notifyOnDownloadComplete', v)}
              label="Notify on completion"
            />
          }
        />
      </SettingsSection>

      <SettingsSection label="POST-PROCESSING">
        <SettingRow
          title="Auto-send audio downloads to Stems"
          description="When a completed download is audio (m4a, mp3, etc.), hand it to the Stems tab automatically — same as clicking the Stems button on the row. Requires Demucs to be installed in Settings → Stems."
          control={
            <Toggle
              checked={settings.downloaderAutoStems}
              onChange={(v) => onChange('downloaderAutoStems', v)}
              label="Auto-send audio to Stems"
            />
          }
        />
      </SettingsSection>
    </SettingsTab>
  );
};
