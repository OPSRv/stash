import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Toggle } from '../shared/ui/Toggle';
import { Select } from '../shared/ui/Select';
import { ConfirmDialog } from '../shared/ui/ConfirmDialog';
import { useToast } from '../shared/ui/Toast';
import { Button } from '../shared/ui/Button';
import { SegmentedControl } from '../shared/ui/SegmentedControl';
import { Surface } from '../shared/ui/Surface';
import {
  purgeCookies,
  setCookiesBrowser,
  setDownloadsDir,
  setMaxParallel,
  setRateLimit,
  updateYtDlp,
  ytDlpVersion,
  type YtDlpVersionInfo,
} from '../modules/downloader/api';
import { setTranslatorSettings, translate } from '../modules/translator/api';
import { TARGET_LANGUAGES } from '../modules/translator/languages';
import { DEFAULT_SETTINGS, loadSettings, saveSetting, type Settings } from './store';
import { ACCENTS, applyTheme, type AccentKey, type ThemeMode } from './theme';

type Tab = 'general' | 'appearance' | 'clipboard' | 'downloads' | 'about';

const tabs: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'clipboard', label: 'Clipboard' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'about', label: 'About' },
];

export const SettingsShell = () => {
  const [tab, setTab] = useState<Tab>('general');
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [autostartOn, setAutostartOn] = useState(false);

  useEffect(() => {
    loadSettings()
      .then((s) => {
        setSettings(s);
        applyTheme({
          mode: s.themeMode,
          blur: s.themeBlur,
          paneOpacity: s.themePaneOpacity,
          accent: s.themeAccent,
        });
      })
      .catch(console.error);
    isEnabled().then(setAutostartOn).catch(console.error);
  }, []);

  const update = async <K extends keyof Settings>(key: K, value: Settings[K]) => {
    const nextSettings = { ...settings, [key]: value };
    setSettings(nextSettings);
    await saveSetting(key, value).catch(console.error);
    if (
      key === 'themeMode' ||
      key === 'themeBlur' ||
      key === 'themePaneOpacity' ||
      key === 'themeAccent'
    ) {
      applyTheme({
        mode: nextSettings.themeMode,
        blur: nextSettings.themeBlur,
        paneOpacity: nextSettings.themePaneOpacity,
        accent: nextSettings.themeAccent,
      });
    }
    if (key === 'downloadsFolder') {
      await setDownloadsDir(value as string | null).catch(console.error);
    }
    if (key === 'cookiesFromBrowser') {
      await setCookiesBrowser(value as string | null).catch(console.error);
      // Destroy the embedded Music webview so next open rebuilds it with
      // the UA derived from the new browser choice.
      await invoke('music_close').catch(() => {});
    }
    if (key === 'maxParallelDownloads') {
      await setMaxParallel(value as number).catch(console.error);
    }
    if (key === 'downloadRateLimit') {
      await setRateLimit(value as string | null).catch(console.error);
    }
    if (
      key === 'translateEnabled' ||
      key === 'translateTarget' ||
      key === 'translateMinChars'
    ) {
      await setTranslatorSettings({
        enabled: nextSettings.translateEnabled,
        target: nextSettings.translateTarget,
        minChars: nextSettings.translateMinChars,
      }).catch(console.error);
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
        {tab === 'appearance' && (
          <AppearanceTab settings={settings} onChange={update} />
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
          aria-label="Max history items"
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
    <SettingRow
      title="Auto-translate foreign clips"
      description="When you copy text in another script (e.g. English), translate it and show a popup with the result."
      control={
        <Toggle
          checked={settings.translateEnabled}
          onChange={(v) => onChange('translateEnabled', v)}
          label="Auto-translate"
        />
      }
    />
    {settings.translateEnabled && (
      <>
        <SettingRow
          title="Translate into"
          description="Target language. Source is detected automatically."
          control={
            <Select
              label="Translate into"
              value={settings.translateTarget}
              onChange={(v) => onChange('translateTarget', v)}
              options={TARGET_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
            />
          }
        />
        <SettingRow
          title="Minimum length"
          description="Skip very short clips so single words don't spam the banner."
          control={
            <input
              aria-label="Minimum translate length"
              type="number"
              min={1}
              max={200}
              value={settings.translateMinChars}
              onChange={(e) =>
                onChange(
                  'translateMinChars',
                  Math.max(1, Math.min(200, Number(e.currentTarget.value) || 1))
                )
              }
              className="input-field rounded-md px-2 py-1 w-20 text-body"
            />
          }
        />
        <SettingRow
          title="Show system notification"
          description="Also send a native notification so translations reach you when the popup is hidden."
          control={
            <Toggle
              checked={settings.translateShowNotification}
              onChange={(v) => onChange('translateShowNotification', v)}
              label="Notification on translation"
            />
          }
        />
        <TranslatorTestRow target={settings.translateTarget} />
      </>
    )}
  </div>
);

const TranslatorTestRow = ({ target }: { target: string }) => {
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const t = await translate('Hello, how are you today?', target);
      setResult(t.translated);
      toast({ title: 'Translator works', description: t.translated, variant: 'success' });
    } catch (e) {
      const msg = String(e);
      setResult(`Error: ${msg}`);
      toast({
        title: 'Translator test failed',
        description: msg,
        variant: 'error',
        action: { label: 'Retry', onClick: () => void run() },
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingRow
      title="Test translator"
      description={
        result ?? 'Sends a short sentence through the pipeline to verify the network and target language.'
      }
      control={
        <button
          onClick={run}
          disabled={busy}
          className="px-3 py-1 rounded-md t-primary text-meta"
          style={{ background: 'rgba(255,255,255,0.06)', opacity: busy ? 0.6 : 1 }}
        >
          {busy ? 'Testing…' : 'Run test'}
        </button>
      }
    />
  );
};

const DownloadsTab = ({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}) => {
  const [forgetOpen, setForgetOpen] = useState(false);
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
  return (
    <div className="divide-y divide-white/5">
      <YtDlpUpdateRow />
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
          <input
            aria-label="Max parallel downloads"
            type="number"
            min={1}
            max={10}
            value={settings.maxParallelDownloads}
            onChange={(e) =>
              onChange(
                'maxParallelDownloads',
                Math.max(1, Math.min(10, Number(e.currentTarget.value) || 1))
              )
            }
            className="input-field rounded-md px-2 py-1 w-20 text-body"
          />
        }
      />
      <SettingRow
        title="Bandwidth limit"
        description='yt-dlp rate syntax: "500K", "2M", "1.5M". Empty = unlimited.'
        control={
          <input
            aria-label="Bandwidth limit"
            type="text"
            placeholder="unlimited"
            value={settings.downloadRateLimit ?? ''}
            onChange={(e) =>
              onChange(
                'downloadRateLimit',
                (e.currentTarget.value.trim() || null) as string | null
              )
            }
            className="input-field rounded-md px-2 py-1 w-24 text-body"
          />
        }
      />
      <SettingRow
        title="History retention"
        description="Days before completed/failed jobs vanish from the Downloads list (files are not removed)."
        control={
          <input
            aria-label="History retention days"
            type="number"
            min={1}
            max={365}
            value={settings.historyRetentionDays}
            onChange={(e) =>
              onChange(
                'historyRetentionDays',
                Math.max(1, Math.min(365, Number(e.currentTarget.value) || 60))
              )
            }
            className="input-field rounded-md px-2 py-1 w-20 text-body"
          />
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
          <button
            onClick={() => setForgetOpen(true)}
            className="px-3 py-1 rounded-md t-primary text-meta"
            style={{ background: 'rgba(235,72,72,0.15)', color: '#FF7878' }}
          >
            Forget
          </button>
        }
      />
      <ConfirmDialog
        open={forgetOpen}
        title="Forget browser cookies?"
        description="The exported cookies file will be deleted and the browser disconnected. You can re-link it any time."
        confirmLabel="Forget"
        tone="danger"
        onConfirm={async () => {
          setForgetOpen(false);
          try {
            await purgeCookies();
            onChange('cookiesFromBrowser', null);
            toast({ title: 'Cookies forgotten', variant: 'success' });
          } catch (e) {
            console.error('purge cookies failed', e);
            toast({ title: 'Forget failed', description: String(e), variant: 'error' });
          }
        }}
        onCancel={() => setForgetOpen(false)}
      />
    </div>
  );
};

const YtDlpUpdateRow = () => {
  const [info, setInfo] = useState<YtDlpVersionInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setInfo(await ytDlpVersion());
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    refresh();
    // Daily check for a newer release; non-blocking, silent on failure.
    const t = setInterval(refresh, 24 * 60 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  const update = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateYtDlp();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const outdated =
    info?.installed &&
    info?.latest &&
    !info.installed.endsWith(info.latest) &&
    info.installed !== info.latest;

  return (
    <SettingRow
      title="yt-dlp binary"
      description={
        error
          ? `Could not check: ${error}`
          : info
            ? `Installed: ${info.installed ?? 'unknown'} · Latest: ${info.latest ?? 'unknown'}${
                outdated ? ' — update available' : ''
              }`
            : 'Checking…'
      }
      control={
        <button
          onClick={update}
          disabled={busy}
          className="px-3 py-1 rounded-md t-primary text-meta"
          style={{
            background: outdated ? 'rgba(47,122,229,0.22)' : 'rgba(255,255,255,0.06)',
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? 'Updating…' : outdated ? 'Update now' : 'Re-install'}
        </button>
      }
    />
  );
};

// Matches the Rust-side `material_for_strength` bucketing.
const blurLabel = (v: number) => {
  if (v === 0) return 'Off';
  if (v < 10) return 'Sidebar (thin)';
  if (v < 25) return 'HUD (medium)';
  if (v < 40) return 'Under-window';
  if (v < 55) return 'Fullscreen';
  return 'Under-page (heaviest)';
};

const THEME_MODES: { id: ThemeMode; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'auto', label: 'Auto' },
];

const AppearanceTab = ({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}) => (
  <div className="space-y-5">
    <Surface rounded="xl" elevation="raised" className="p-4 flex items-center gap-3">
      <div className="flex-1">
        <div className="t-primary text-body font-medium">Live preview</div>
        <div className="t-tertiary text-meta">Reflects current blur, translucency, and accent.</div>
      </div>
      <span
        className="inline-block w-7 h-7 rounded-full"
        style={{ background: ACCENTS[settings.themeAccent].hex }}
        aria-hidden
      />
    </Surface>

    <div className="divide-y divide-white/5">
      <SettingRow
        title="Theme"
        description="Dark, light, or follow the system appearance."
        control={
          <SegmentedControl
            ariaLabel="Theme mode"
            options={THEME_MODES.map((m) => ({ value: m.id, label: m.label }))}
            value={settings.themeMode}
            onChange={(v) => onChange('themeMode', v as ThemeMode)}
          />
        }
      />
      <SettingRow
        title="Popup blur"
        description={`Vibrancy strength · ${blurLabel(settings.themeBlur)}`}
        control={
          <input
            aria-label="Popup blur"
            type="range"
            min={0}
            max={60}
            step={2}
            value={settings.themeBlur}
            onChange={(e) => onChange('themeBlur', Number(e.currentTarget.value))}
            className="w-40"
          />
        }
      />
      <SettingRow
        title="Popup translucency"
        description={`How see-through the popup is · ${Math.round(
          settings.themePaneOpacity * 100
        )}%`}
        control={
          <input
            aria-label="Popup translucency"
            type="range"
            min={0}
            max={100}
            step={2}
            value={Math.round(settings.themePaneOpacity * 100)}
            onChange={(e) =>
              onChange(
                'themePaneOpacity',
                Math.max(0, Math.min(1, Number(e.currentTarget.value) / 100))
              )
            }
            className="w-40"
          />
        }
      />
      <SettingRow
        title="Accent color"
        description="Used for active selections, links, and primary buttons."
        control={
          <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Accent">
            {(Object.keys(ACCENTS) as AccentKey[]).map((k) => {
              const a = ACCENTS[k];
              const selected = settings.themeAccent === k;
              return (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => onChange('themeAccent', k)}
                  title={a.label}
                  aria-label={`Accent ${a.label}`}
                  className="w-6 h-6 rounded-full transition-transform"
                  style={{
                    background: a.hex,
                    outline: selected
                      ? `2px solid rgba(255,255,255,0.9)`
                      : '1px solid rgba(255,255,255,0.15)',
                    outlineOffset: selected ? 2 : 0,
                    transform: selected ? 'scale(1.05)' : 'scale(1)',
                  }}
                />
              );
            })}
          </div>
        }
      />
      <SettingRow
        title="Reset to defaults"
        description="Theme only — other settings are unchanged."
        control={
          <Button
            size="sm"
            onClick={() => {
              onChange('themeMode', DEFAULT_SETTINGS.themeMode);
              onChange('themeBlur', DEFAULT_SETTINGS.themeBlur);
              onChange('themePaneOpacity', DEFAULT_SETTINGS.themePaneOpacity);
              onChange('themeAccent', DEFAULT_SETTINGS.themeAccent);
            }}
          >
            Reset
          </Button>
        }
      />
    </div>
  </div>
);

const AboutTab = () => {
  const [ytVersion, setYtVersion] = useState<string | null>(null);
  const [sentReport, setSentReport] = useState<string | null>(null);

  useEffect(() => {
    ytDlpVersion()
      .then((v) => setYtVersion(v.installed))
      .catch(() => {});
  }, []);

  const openGitHub = () => {
    // Use the Tauri opener plugin via its plugin command for consistency with
    // `revealItemInDir` elsewhere in the app.
    import('@tauri-apps/plugin-opener')
      .then(({ openUrl }) => openUrl('https://github.com/OPSRv/stash'))
      .catch((e) => console.error('open GitHub failed', e));
  };

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
    <div className="t-secondary text-body space-y-4">
      <div>
        <div className="t-primary text-heading font-medium">Stash</div>
        <div>macOS menubar multitool — clipboard, downloads, recorder.</div>
        <div className="t-tertiary text-meta">
          v0.1.0 {ytVersion && <>· yt-dlp {ytVersion}</>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={openGitHub}>
          Open GitHub
        </Button>
        <Button size="sm" onClick={openDataFolder}>
          Open data folder
        </Button>
        <Button size="sm" onClick={sendLogs}>
          Send logs
        </Button>
      </div>
      {sentReport && (
        <div className="t-tertiary text-meta">Report written to {sentReport}</div>
      )}
    </div>
  );
};
