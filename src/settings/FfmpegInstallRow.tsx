import { useEffect, useRef, useState } from 'react';
import { Button } from '../shared/ui/Button';
import { useToast } from '../shared/ui/Toast';
import { ffmpegStatus, installFfmpeg, type FfmpegStatus } from '../modules/downloader/api';
import { SettingRow } from './SettingRow';

/// Inline row that surfaces whether yt-dlp can find ffmpeg+ffprobe (either
/// via the user's Homebrew/PATH install or the Stash-managed bundle under
/// `<downloads>/bin`) and offers a one-click download of the bundle. The
/// download fetches static macOS builds from evermeet.cx and verifies them
/// against the published SHA-256 — same trust model as the yt-dlp binary
/// update row right above.
export const FfmpegInstallRow = () => {
  const [status, setStatus] = useState<FfmpegStatus | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const { toast } = useToast();

  const refresh = async () => {
    try {
      const next = await ffmpegStatus();
      if (mountedRef.current) setStatus(next);
    } catch (e) {
      if (mountedRef.current) setError(String(e));
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleInstall = async () => {
    setIsBusy(true);
    setError(null);
    try {
      const version = await installFfmpeg();
      toast({ title: `ffmpeg ${version} installed`, variant: 'success' });
      await refresh();
    } catch (e) {
      const msg = String(e);
      setError(msg);
      toast({ title: 'ffmpeg install failed', description: msg, variant: 'error' });
    } finally {
      setIsBusy(false);
    }
  };

  const description = error
    ? `Could not check: ${error}`
    : !status
      ? 'Checking…'
      : status.dir
        ? `${status.bundled ? 'Bundled' : 'System'}: ${status.version ?? 'unknown'} · ${status.dir}`
        : 'Not found — yt-dlp postprocessing (audio extract, mp4 mux) will fail until ffmpeg is available.';

  const label = isBusy
    ? 'Installing…'
    : status?.dir
      ? 'Re-install'
      : 'Install';

  return (
    <SettingRow
      title="ffmpeg + ffprobe"
      description={description}
      control={
        <Button
          variant="soft"
          tone={!status?.dir ? 'accent' : 'neutral'}
          size="sm"
          loading={isBusy}
          onClick={handleInstall}
        >
          {label}
        </Button>
      }
    />
  );
};
