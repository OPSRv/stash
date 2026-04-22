import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Button } from '../shared/ui/Button';
import { ConfirmDialog } from '../shared/ui/ConfirmDialog';
import { Input } from '../shared/ui/Input';
import { NumberInput } from '../shared/ui/NumberInput';
import { Select } from '../shared/ui/Select';
import { Toggle } from '../shared/ui/Toggle';
import { useToast } from '../shared/ui/Toast';
import { purgeCookies } from '../modules/downloader/api';
import { SettingRow } from './SettingRow';
import { SettingsSectionHeader } from './SettingsSectionHeader';
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
  const [isForgetOpen, setIsForgetOpen] = useState(false);
  const { toast } = useToast();

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

  const handleForget = async () => {
    setIsForgetOpen(false);
    try {
      await purgeCookies();
      onChange('cookiesFromBrowser', null);
      toast({ title: 'Cookies forgotten', variant: 'success' });
    } catch (e) {
      console.error('purge cookies failed', e);
      toast({ title: 'Forget failed', description: String(e), variant: 'error' });
    }
  };

  return (
    <div className="max-w-[560px] mx-auto space-y-6">
      <section>
        <SettingsSectionHeader label="BINARY" />
        <div className="divide-y divide-white/5">
          <YtDlpUpdateRow />
        </div>
      </section>

      <section>
        <SettingsSectionHeader label="STORAGE" />
        <div className="divide-y divide-white/5">
      <SettingRow
        title="Download folder"
        description={settings.downloadsFolder ?? 'Default: ~/Movies/Stash'}
        control={
          <div className="flex items-center gap-2">
            <button
              onClick={pickFolder}
              className="px-3 py-1 rounded-md t-primary text-meta"
              style={{ background: 'rgba(255,255,255,0.06)' }}
            >
              Choose…
            </button>
            {settings.downloadsFolder && (
              <button
                onClick={() => onChange('downloadsFolder', null)}
                className="t-tertiary text-meta hover:t-secondary"
              >
                Reset
              </button>
            )}
          </div>
        }
      />
      <SettingRow
        title="Max parallel downloads"
        description="Extra jobs wait in a queue and start as slots free up."
        control={
          <NumberInput
            ariaLabel="Max parallel downloads"
            min={1}
            max={10}
            value={settings.maxParallelDownloads}
            onChange={(v) =>
              onChange(
                'maxParallelDownloads',
                Math.max(1, Math.min(10, v ?? 1)),
              )
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
            ariaLabel="History retention days"
            min={1}
            max={365}
            value={settings.historyRetentionDays}
            onChange={(v) =>
              onChange(
                'historyRetentionDays',
                Math.max(1, Math.min(365, v ?? 60)),
              )
            }
            suffix="d"
            className="w-28"
          />
        }
      />
        </div>
      </section>

      <section>
        <SettingsSectionHeader label="NOTIFICATIONS" />
        <div className="divide-y divide-white/5">
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
        </div>
      </section>

      <section>
        <SettingsSectionHeader label="COOKIES" />
        <div className="divide-y divide-white/5">
      <SettingRow
        title="Default browser"
        description="Used across the app: as the cookie source for yt-dlp on login-walled content, and as the identity for embedded web views (Music). Safari is the safest choice on macOS."
        control={
          <Select
            label="Default browser"
            value={settings.cookiesFromBrowser ?? ''}
            onChange={(v) =>
              onChange('cookiesFromBrowser', (v || null) as Settings['cookiesFromBrowser'])
            }
            options={[
              { value: '', label: 'None' },
              { value: 'arc', label: 'Arc' },
              { value: 'safari', label: 'Safari' },
              { value: 'chrome', label: 'Chrome' },
              { value: 'firefox', label: 'Firefox' },
              { value: 'edge', label: 'Edge' },
              { value: 'brave', label: 'Brave' },
              { value: 'vivaldi', label: 'Vivaldi' },
              { value: 'chromium', label: 'Chromium' },
            ]}
          />
        }
      />
      <SettingRow
        title="Forget cookies"
        description="Remove the exported cookies file and disconnect the browser."
        control={
          <Button variant="soft" tone="danger" size="sm" onClick={() => setIsForgetOpen(true)}>
            Forget
          </Button>
        }
      />
        </div>
      </section>

      <ConfirmDialog
        open={isForgetOpen}
        title="Forget browser cookies?"
        description="The exported cookies file will be deleted and the browser disconnected. You can re-link it any time."
        confirmLabel="Forget"
        tone="danger"
        onConfirm={handleForget}
        onCancel={() => setIsForgetOpen(false)}
      />
    </div>
  );
};
