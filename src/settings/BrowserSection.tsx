import { useState } from 'react';
import { Button } from '../shared/ui/Button';
import { ConfirmDialog } from '../shared/ui/ConfirmDialog';
import { Select } from '../shared/ui/Select';
import { useToast } from '../shared/ui/Toast';
import { purgeCookies } from '../modules/downloader/api';
import { SettingRow } from './SettingRow';
import { SettingsSection } from './SettingsLayout';
import type { Settings } from './store';

interface BrowserSectionProps {
  settings: Settings;
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

/// App-wide browser identity. Used by:
///   • yt-dlp as a cookie source for login-walled content (Downloads).
///   • Embedded webviews (Music) as the user-agent / cookie origin.
/// Lives under General because it isn't a per-tab concern.
export const BrowserSection = ({ settings, onChange }: BrowserSectionProps) => {
  const { toast } = useToast();
  const [isForgetOpen, setIsForgetOpen] = useState(false);

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
    <SettingsSection label="BROWSER">
      <SettingRow
        title="Default browser"
        description="Used across the app: as the cookie source for yt-dlp on login-walled content, and as the identity for embedded web views (Music). Safari is the safest choice on macOS."
        control={
          <Select
            size="sm"
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
      <ConfirmDialog
        open={isForgetOpen}
        title="Forget browser cookies?"
        description="The exported cookies file will be deleted and the browser disconnected. You can re-link it any time."
        confirmLabel="Forget"
        tone="danger"
        onConfirm={handleForget}
        onCancel={() => setIsForgetOpen(false)}
      />
    </SettingsSection>
  );
};
