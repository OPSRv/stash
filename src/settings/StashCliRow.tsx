import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { Button } from '../shared/ui/Button';
import { SettingRow } from './SettingRow';

interface StashCliStatus {
  binary_available: boolean;
  binary_path: string | null;
  installed_at: string | null;
}

const EMPTY: StashCliStatus = {
  binary_available: false,
  binary_path: null,
  installed_at: null,
};

/// Settings row for the `stash` CLI installer. Shows the current
/// install path (or "Not installed") and flips between Install and
/// Uninstall based on state. The actual symlink work happens in Rust —
/// this component only orchestrates the UI.
export const StashCliRow = () => {
  const [status, setStatus] = useState<StashCliStatus>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<StashCliStatus | unknown>('stash_cli_status');
      if (
        next &&
        typeof next === 'object' &&
        'installed_at' in next &&
        'binary_available' in next
      ) {
        setStatus(next as StashCliStatus);
      } else {
        setStatus(EMPTY);
      }
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onInstall = async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke<string>('stash_cli_install');
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onUninstall = async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke<void>('stash_cli_uninstall');
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const installed = status.installed_at !== null;

  const description = installed
    ? `Installed at ${status.installed_at}`
    : status.binary_available
      ? 'Run `stash` from any Terminal window — handy with shell scripts and Claude Code.'
      : 'CLI binary is missing. Build the app (or run `npm run build:cli`) to enable.';

  return (
    <>
      <SettingRow
        title="Command-line tool (stash)"
        description={description}
        control={
          installed ? (
            <Button size="sm" variant="soft" tone="neutral" onClick={onUninstall} disabled={busy}>
              Uninstall
            </Button>
          ) : (
            <Button
              size="sm"
              variant="solid"
              tone="accent"
              onClick={onInstall}
              disabled={busy || !status.binary_available}
            >
              Install
            </Button>
          )
        }
      />
      {error && (
        <div className="t-danger text-meta px-0 pb-2" role="alert">
          {error}
        </div>
      )}
    </>
  );
};
