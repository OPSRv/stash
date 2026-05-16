import { useCallback, useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';

import { Button } from '../shared/ui/Button';
import { accent } from '../shared/theme/accent';

const RELEASES_API = 'https://api.github.com/repos/OPSRv/stash/releases/latest';
const RELEASE_PAGE = 'https://github.com/OPSRv/stash/releases/latest';
const DOWNLOAD_URL =
  'https://github.com/OPSRv/stash/releases/latest/download/Stash_arm64.dmg';

/// Strips leading `v` and semver pre-release suffix (`-nightly+abc123`) so a
/// running `0.1.0-nightly+abc123` compares cleanly against a tag like `v0.1.1`.
const normalise = (v: string): string => v.replace(/^v/i, '').split(/[-+]/)[0];

const cmpSemver = (a: string, b: string): number => {
  const pa = normalise(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = normalise(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
};

const openUrl = (url: string) => {
  import('@tauri-apps/plugin-opener')
    .then(({ openUrl: open }) => open(url))
    .catch((e) => console.error('open url failed', e));
};

/// `tauri-plugin-updater` does the heavy lifting (fetch latest.json from the
/// endpoint in tauri.conf.json, verify the ed25519 signature against the
/// configured pubkey, download the .app.tar.gz, swap the bundle in place).
/// We then call `process.relaunch()` so the user lands in the new build
/// without quitting the menubar by hand. Falls back gracefully to the manual
/// "Download .dmg" path when the plugin reports no signed update available
/// (i.e. the release was cut without `TAURI_SIGNING_*` secrets configured).
type State =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'uptodate'; version: string }
  | { kind: 'available'; latest: string; current: string }
  | { kind: 'downloading'; progress: number | null }
  | { kind: 'installed' }
  | { kind: 'manual'; latest: string; current: string; reason: string }
  | { kind: 'error'; message: string };

export const UpdateCheckRow = () => {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  /// Fallback: ask GitHub directly for the latest tag. Used when the updater
  /// plugin returns null (no signed manifest yet) so we still surface
  /// "v0.1.24 is out" with a manual download button.
  const githubLatestTag = async (): Promise<string | null> => {
    try {
      const res = await fetch(RELEASES_API, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { tag_name?: string; name?: string };
      return body.tag_name ?? body.name ?? null;
    } catch {
      return null;
    }
  };

  const check = useCallback(async () => {
    setState({ kind: 'checking' });
    const current = await getVersion().catch(() => '0.0.0');
    try {
      const { check: checkUpdate } = await import('@tauri-apps/plugin-updater');
      const update = await checkUpdate();
      if (!mountedRef.current) return;
      if (update) {
        setState({
          kind: 'available',
          latest: normalise(update.version),
          current,
        });
        return;
      }
      // Plugin says no signed update. Cross-check the GitHub API in case the
      // release exists but wasn't signed (e.g. before setup-updater.sh was
      // run on CI) — that way the user still gets a clear "newer version
      // exists, install manually" affordance instead of a misleading
      // "you're up to date".
      const tag = await githubLatestTag();
      if (tag && cmpSemver(current, tag) < 0) {
        setState({
          kind: 'manual',
          latest: normalise(tag),
          current,
          reason: 'release not signed for auto-update',
        });
      } else {
        setState({ kind: 'uptodate', version: current });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Plugin throws when no endpoint is configured / pubkey missing /
      // network error. Surface what we can and offer the manual path.
      const tag = await githubLatestTag();
      if (!mountedRef.current) return;
      if (tag && cmpSemver(current, tag) < 0) {
        setState({
          kind: 'manual',
          latest: normalise(tag),
          current,
          reason: message,
        });
      } else {
        setState({ kind: 'error', message });
      }
    }
  }, []);

  const installAndRestart = useCallback(async () => {
    setState({ kind: 'downloading', progress: null });
    try {
      const { check: checkUpdate } = await import('@tauri-apps/plugin-updater');
      const { relaunch } = await import('@tauri-apps/plugin-process');
      const update = await checkUpdate();
      if (!update) {
        if (mountedRef.current) {
          setState({
            kind: 'error',
            message: 'Update vanished between check and install — try again.',
          });
        }
        return;
      }
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        if (!mountedRef.current) return;
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0;
          setState({ kind: 'downloading', progress: total > 0 ? 0 : null });
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          const pct = total > 0 ? Math.min(1, downloaded / total) : null;
          setState({ kind: 'downloading', progress: pct });
        }
      });
      if (!mountedRef.current) return;
      setState({ kind: 'installed' });
      // Tiny pause so the user sees the success state before the relaunch
      // wipes the window.
      setTimeout(() => {
        relaunch().catch((e) => {
          if (mountedRef.current) {
            setState({
              kind: 'error',
              message: `Installed, but relaunch failed: ${e}`,
            });
          }
        });
      }, 600);
    } catch (e) {
      if (mountedRef.current) {
        setState({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="xs"
        onClick={check}
        disabled={state.kind === 'checking' || state.kind === 'downloading'}
      >
        {state.kind === 'checking' ? 'Checking…' : 'Check for updates'}
      </Button>
      {state.kind === 'uptodate' && (
        <span className="t-tertiary text-meta">
          You're on the latest build (v{state.version}).
        </span>
      )}
      {state.kind === 'available' && (
        <div className="flex items-center gap-2 text-meta">
          <span
            className="rounded px-1.5 py-0.5"
            style={{
              background: accent(0.16),
              color: 'rgb(var(--stash-accent-rgb))',
            }}
          >
            v{state.latest} is out
          </span>
          <Button size="xs" tone="accent" variant="solid" onClick={installAndRestart}>
            Install & restart
          </Button>
          <Button size="xs" variant="ghost" onClick={() => openUrl(RELEASE_PAGE)}>
            Release notes
          </Button>
        </div>
      )}
      {state.kind === 'downloading' && (
        <span className="t-tertiary text-meta">
          {state.progress !== null
            ? `Downloading… ${Math.round(state.progress * 100)}%`
            : 'Downloading…'}
        </span>
      )}
      {state.kind === 'installed' && (
        <span className="t-tertiary text-meta">Installed — restarting…</span>
      )}
      {state.kind === 'manual' && (
        <div className="flex items-center gap-2 text-meta">
          <span
            className="rounded px-1.5 py-0.5"
            style={{
              background: accent(0.16),
              color: 'rgb(var(--stash-accent-rgb))',
            }}
          >
            v{state.latest} is out
          </span>
          <Button size="xs" tone="accent" variant="solid" onClick={() => openUrl(DOWNLOAD_URL)}>
            Download .dmg
          </Button>
          <Button size="xs" variant="ghost" onClick={() => openUrl(RELEASE_PAGE)}>
            Release notes
          </Button>
          <span className="t-tertiary" title={state.reason}>
            (manual install)
          </span>
        </div>
      )}
      {state.kind === 'error' && (
        <span className="text-meta" style={{ color: '#f87171' }}>
          Update failed: {state.message}
        </span>
      )}
    </div>
  );
};
