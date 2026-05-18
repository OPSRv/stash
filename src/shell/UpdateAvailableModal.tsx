import { useCallback, useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';

import { Modal } from '../shared/ui/Modal';
import { Button } from '../shared/ui/Button';
import { accent } from '../shared/theme/accent';

const RELEASE_PAGE = 'https://github.com/OPSRv/stash/releases/latest';
const DOWNLOAD_URL =
  'https://github.com/OPSRv/stash/releases/latest/download/Stash_arm64.dmg';
const RELEASES_API = 'https://api.github.com/repos/OPSRv/stash/releases/latest';

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

/// Session-scoped guard. PopupShell mounts once per app launch (Tauri menubar
/// keeps it alive across ⌘⇧V toggles), but the module flag is belt-and-braces
/// against future remounts and React StrictMode double-invoke in dev.
let shownThisSession = false;

type State =
  | { kind: 'hidden' }
  | { kind: 'prompt'; latest: string; current: string; signed: boolean }
  | { kind: 'downloading'; progress: number | null; latest: string }
  | { kind: 'installed' }
  | { kind: 'error'; message: string };

export const UpdateAvailableModal = () => {
  const [state, setState] = useState<State>({ kind: 'hidden' });
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  useEffect(() => {
    if (shownThisSession) return;
    if (import.meta.env.MODE === 'test') return;
    shownThisSession = true;
    let cancelled = false;
    (async () => {
      const current = await getVersion().catch(() => '0.0.0');
      try {
        const { check: checkUpdate } = await import('@tauri-apps/plugin-updater');
        const update = await checkUpdate();
        if (cancelled || !mountedRef.current) return;
        if (update) {
          setState({
            kind: 'prompt',
            latest: normalise(update.version),
            current,
            signed: true,
          });
          return;
        }
        // Updater says nothing signed — cross-check GitHub so we still surface
        // an unsigned release with a manual-download fallback.
        const res = await fetch(RELEASES_API, {
          headers: { Accept: 'application/vnd.github+json' },
        }).catch(() => null);
        if (!res || !res.ok) return;
        const body = (await res.json().catch(() => null)) as
          | { tag_name?: string; name?: string }
          | null;
        const tag = body?.tag_name ?? body?.name ?? null;
        if (cancelled || !mountedRef.current) return;
        if (tag && cmpSemver(current, tag) < 0) {
          setState({
            kind: 'prompt',
            latest: normalise(tag),
            current,
            signed: false,
          });
        }
      } catch {
        // Silent — the Settings → About row still lets the user check manually.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const close = useCallback(() => {
    setState({ kind: 'hidden' });
  }, []);

  const installAndRestart = useCallback(async () => {
    if (state.kind !== 'prompt') return;
    if (!state.signed) {
      openUrl(DOWNLOAD_URL);
      close();
      return;
    }
    const latest = state.latest;
    setState({ kind: 'downloading', progress: null, latest });
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
          setState({
            kind: 'downloading',
            progress: total > 0 ? 0 : null,
            latest,
          });
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          const pct = total > 0 ? Math.min(1, downloaded / total) : null;
          setState({ kind: 'downloading', progress: pct, latest });
        }
      });
      if (!mountedRef.current) return;
      setState({ kind: 'installed' });
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
  }, [state, close]);

  if (state.kind === 'hidden') return null;

  const downloading = state.kind === 'downloading';
  const installed = state.kind === 'installed';
  const errored = state.kind === 'error';
  const busy = downloading || installed;

  return (
    <Modal
      open
      onClose={busy ? () => {} : close}
      ariaLabel="Update available"
      maxWidth={420}
      dismissOnBackdropClick={!busy}
      dismissOnEscape={!busy}
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span
            className="rounded px-1.5 py-0.5 text-meta"
            style={{
              background: accent(0.16),
              color: 'rgb(var(--stash-accent-rgb))',
            }}
          >
            {state.kind === 'prompt'
              ? `v${state.latest} is out`
              : downloading
                ? `v${state.latest}`
                : 'Update'}
          </span>
          <h2 className="text-title t-primary">A new version of Stash is available</h2>
        </div>

        {state.kind === 'prompt' && (
          <>
            <p className="text-body t-secondary">
              You're on v{state.current}. Stash will download the update in the
              background, then <strong className="t-primary">restart itself</strong> to
              apply it.
            </p>
            <p className="text-meta t-tertiary">
              Any unsaved work in other tabs may be lost during the restart — finish
              what you're doing first, or choose "Later" to update next time.
            </p>
            {!state.signed && (
              <p className="text-meta t-tertiary">
                This release isn't signed for auto-update, so "Update now" will open
                the .dmg download in your browser.
              </p>
            )}
          </>
        )}

        {downloading && (
          <div className="flex flex-col gap-2">
            <div className="text-body t-secondary">
              {state.progress !== null
                ? `Downloading… ${Math.round(state.progress * 100)}%`
                : 'Downloading…'}
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded"
              style={{ background: 'rgba(127,127,127,0.18)' }}
            >
              <div
                className="h-full rounded transition-[width] duration-150"
                style={{
                  width:
                    state.progress !== null
                      ? `${Math.round(state.progress * 100)}%`
                      : '35%',
                  background: 'rgb(var(--stash-accent-rgb))',
                  opacity: state.progress !== null ? 1 : 0.6,
                }}
              />
            </div>
            <p className="text-meta t-tertiary">
              Stash will restart automatically once the download finishes. Don't quit
              the app until then.
            </p>
          </div>
        )}

        {installed && (
          <p className="text-body t-secondary">Installed — restarting…</p>
        )}

        {errored && (
          <p className="text-body" style={{ color: '#f87171' }}>
            Update failed: {state.message}
          </p>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          {state.kind === 'prompt' && (
            <>
              <Button size="sm" variant="ghost" onClick={() => openUrl(RELEASE_PAGE)}>
                Release notes
              </Button>
              <Button size="sm" variant="ghost" onClick={close}>
                Later
              </Button>
              <Button
                size="sm"
                tone="accent"
                variant="solid"
                onClick={installAndRestart}
              >
                {state.signed ? 'Update now' : 'Download .dmg'}
              </Button>
            </>
          )}
          {errored && (
            <Button size="sm" variant="ghost" onClick={close}>
              Close
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
};
