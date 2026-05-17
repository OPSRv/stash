import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../shared/ui/Button';
import { useToast } from '../shared/ui/Toast';
import {
  neuralNoteInstall,
  neuralNoteOpen,
  neuralNoteStatus,
  type NeuralNoteStatus,
} from '../modules/neuralnote/api';
import { SettingRow } from './SettingRow';

/// Settings row that wraps NeuralNote's third-party .pkg installer.
/// The install button downloads the official installer from GitHub
/// Releases and hands it to macOS's own Installer.app — the user gets
/// the standard four-click flow + admin prompt, no Stash-side sudo.
/// After Install completes, we poll status every 2 s for a minute so
/// the row flips to "Installed · v1.1.0" automatically.
export const NeuralNoteInstallRow = () => {
  const [status, setStatus] = useState<NeuralNoteStatus | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const mountedRef = useRef(true);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    try {
      const next = await neuralNoteStatus();
      if (mountedRef.current) setStatus(next);
    } catch {
      // status() is infallible on Rust side, so a thrown error means a
      // genuinely lost IPC bridge — nothing to surface in the row.
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  const handleInstall = async () => {
    setIsBusy(true);
    try {
      await neuralNoteInstall();
      toast({
        title: 'Installer launched',
        description: 'Complete the wizard and enter your admin password.',
        variant: 'default',
      });
      // Poll for up to 60s — usually picks up within 10-20s of the
      // user finishing the wizard. Stops the moment we see installed=true.
      const start = Date.now();
      const poll = window.setInterval(async () => {
        const s = await neuralNoteStatus().catch(() => null);
        if (!mountedRef.current) {
          window.clearInterval(poll);
          return;
        }
        if (s?.installed) {
          setStatus(s);
          window.clearInterval(poll);
        } else if (Date.now() - start > 60_000) {
          window.clearInterval(poll);
        }
      }, 2_000);
    } catch (e) {
      toast({
        title: 'Install failed',
        description: String(e),
        variant: 'error',
      });
    } finally {
      setIsBusy(false);
    }
  };

  const handleOpen = async () => {
    try {
      await neuralNoteOpen();
    } catch (e) {
      toast({ title: 'Open failed', description: String(e), variant: 'error' });
    }
  };

  const description = !status
    ? 'Checking…'
    : status.installed
      ? `Installed${status.version ? ` · v${status.version}` : ''} · ${status.app_path}`
      : 'Audio→MIDI standalone app + AU/VST3 plugins. Download from github.com/DamRsn/NeuralNote and have the macOS installer walk you through it.';

  return (
    <SettingRow
      title="NeuralNote"
      description={description}
      control={
        <div className="flex items-center gap-2">
          {status?.installed && (
            <Button size="sm" tone="neutral" variant="ghost" onClick={handleOpen}>
              Open
            </Button>
          )}
          <Button
            variant="soft"
            tone={status?.installed ? 'neutral' : 'accent'}
            size="sm"
            loading={isBusy}
            onClick={handleInstall}
          >
            {isBusy ? 'Downloading…' : status?.installed ? 'Re-install' : 'Install'}
          </Button>
        </div>
      }
    />
  );
};
