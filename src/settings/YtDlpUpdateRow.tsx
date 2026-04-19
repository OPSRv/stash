import { useEffect, useState } from 'react';
import { Button } from '../shared/ui/Button';
import { updateYtDlp, ytDlpVersion, type YtDlpVersionInfo } from '../modules/downloader/api';
import { SettingRow } from './SettingRow';

/// Inline row that shows the currently installed yt-dlp version vs the
/// latest release and triggers an update. Silent background re-check once
/// per day so users don't have to open Settings to discover upgrades.
export const YtDlpUpdateRow = () => {
  const [info, setInfo] = useState<YtDlpVersionInfo | null>(null);
  const [isBusy, setIsBusy] = useState(false);
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
    const interval = setInterval(refresh, 24 * 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const handleUpdate = async () => {
    setIsBusy(true);
    setError(null);
    try {
      await updateYtDlp();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setIsBusy(false);
    }
  };

  const isOutdated = Boolean(
    info?.installed &&
      info?.latest &&
      !info.installed.endsWith(info.latest) &&
      info.installed !== info.latest,
  );

  return (
    <SettingRow
      title="yt-dlp binary"
      description={
        error
          ? `Could not check: ${error}`
          : info
            ? `Installed: ${info.installed ?? 'unknown'} · Latest: ${info.latest ?? 'unknown'}${
                isOutdated ? ' — update available' : ''
              }`
            : 'Checking…'
      }
      control={
        <Button
          variant="soft"
          tone={isOutdated ? 'accent' : 'neutral'}
          size="sm"
          loading={isBusy}
          onClick={handleUpdate}
        >
          {isBusy ? 'Updating…' : isOutdated ? 'Update now' : 'Re-install'}
        </Button>
      }
    />
  );
};
