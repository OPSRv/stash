import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '../shared/ui/Button';
import { ytDlpVersion } from '../modules/downloader/api';

export const AboutTab = () => {
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
