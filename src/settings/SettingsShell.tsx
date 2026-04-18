import { useEffect, useState } from 'react';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Toggle } from '../shared/ui/Toggle';
import { setCookiesBrowser, setDownloadsDir } from '../modules/downloader/api';
import { DEFAULT_SETTINGS, loadSettings, saveSetting, type Settings } from './store';

type Tab = 'general' | 'clipboard' | 'downloads' | 'about';

const tabs: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'clipboard', label: 'Clipboard' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'about', label: 'About' },
];

export const SettingsShell = () => {
  const [tab, setTab] = useState<Tab>('general');
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [autostartOn, setAutostartOn] = useState(false);

  useEffect(() => {
    loadSettings().then(setSettings).catch(console.error);
    isEnabled().then(setAutostartOn).catch(console.error);
  }, []);

  const update = async <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
    await saveSetting(key, value).catch(console.error);
    if (key === 'downloadsFolder') {
      await setDownloadsDir(value as string | null).catch(console.error);
    }
    if (key === 'cookiesFromBrowser') {
      await setCookiesBrowser(value as string | null).catch(console.error);
    }
  };

  const toggleAutostart = async (next: boolean) => {
    setAutostartOn(next);
    try {
      if (next) await enable();
      else await disable();
    } catch (e) {
      console.error('autostart toggle failed', e);
    }
    await update('launchAtLogin', next);
  };

  return (
    <div className="h-full flex flex-col">
      <nav className="px-4 py-2 flex items-center gap-1 border-b hair">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-md text-body font-medium ${
              tab === t.id ? 't-primary' : 't-secondary'
            }`}
            style={tab === t.id ? { background: 'rgba(255,255,255,0.06)' } : undefined}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <main className="flex-1 overflow-y-auto nice-scroll px-6 py-5">
        {tab === 'general' && (
          <GeneralTab autostartOn={autostartOn} onToggleAutostart={toggleAutostart} />
        )}
        {tab === 'clipboard' && (
          <ClipboardTab settings={settings} onChange={update} />
        )}
        {tab === 'downloads' && (
          <DownloadsTab settings={settings} onChange={update} />
        )}
        {tab === 'about' && <AboutTab />}
      </main>
    </div>
  );
};

const SettingRow = ({
  title,
  description,
  control,
}: {
  title: string;
  description?: string;
  control: React.ReactNode;
}) => (
  <div className="flex items-center justify-between py-3">
    <div>
      <div className="t-primary text-body font-medium">{title}</div>
      {description && <div className="t-tertiary text-meta">{description}</div>}
    </div>
    {control}
  </div>
);

const GeneralTab = ({
  autostartOn,
  onToggleAutostart,
}: {
  autostartOn: boolean;
  onToggleAutostart: (next: boolean) => void;
}) => (
  <div className="divide-y divide-white/5">
    <SettingRow
      title="Launch at login"
      description="Starts Stash quietly in the menubar when you log in."
      control={<Toggle checked={autostartOn} onChange={onToggleAutostart} label="Launch at login" />}
    />
  </div>
);

const ClipboardTab = ({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}) => (
  <div className="divide-y divide-white/5">
    <SettingRow
      title="Max history items"
      description="Older unpinned items are trimmed automatically."
      control={
        <input
          type="number"
          min={10}
          max={10000}
          value={settings.maxHistoryItems}
          onChange={(e) =>
            onChange('maxHistoryItems', Math.max(10, Number(e.currentTarget.value) || 0))
          }
          className="input-field rounded-md px-2 py-1 w-24 text-body"
        />
      }
    />
  </div>
);

const DownloadsTab = ({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}) => {
  const pickFolder = async () => {
    try {
      const selected = await openDialog({ directory: true, multiple: false });
      if (typeof selected === 'string') onChange('downloadsFolder', selected);
    } catch (e) {
      console.error('folder pick failed', e);
    }
  };
  return (
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
      <SettingRow
        title="Auth cookies from browser"
        description="Required for login-walled content (Instagram stories, private X posts, age-gated YouTube, etc.). Keep it 'None' for public content."
        control={
          <select
            value={settings.cookiesFromBrowser ?? ''}
            onChange={(e) =>
              onChange('cookiesFromBrowser', (e.currentTarget.value || null) as Settings['cookiesFromBrowser'])
            }
            className="input-field rounded-md px-2 py-1 text-body"
          >
            <option value="">None</option>
            <option value="arc">Arc</option>
            <option value="safari">Safari</option>
            <option value="chrome">Chrome</option>
            <option value="firefox">Firefox</option>
            <option value="edge">Edge</option>
            <option value="brave">Brave</option>
            <option value="vivaldi">Vivaldi</option>
            <option value="chromium">Chromium</option>
          </select>
        }
      />
    </div>
  );
};

const AboutTab = () => (
  <div className="t-secondary text-body space-y-2">
    <div className="t-primary text-heading font-medium">Stash</div>
    <div>macOS menubar multitool — clipboard, downloads, recorder.</div>
    <div className="t-tertiary text-meta">v0.1.0 · github.com/OPSRv/stash</div>
  </div>
);
