import { useCallback, useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';

import { Button } from '../shared/ui/Button';
import { accent } from '../shared/theme/accent';

const RELEASES_API = 'https://api.github.com/repos/OPSRv/stash/releases/latest';
const RELEASE_PAGE = 'https://github.com/OPSRv/stash/releases/latest';
const DOWNLOAD_URL =
  'https://github.com/OPSRv/stash/releases/latest/download/Stash_universal.dmg';

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

type State =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'uptodate'; version: string }
  | { kind: 'update'; latest: string; current: string }
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

  const check = useCallback(async () => {
    setState({ kind: 'checking' });
    try {
      const [currentRaw, res] = await Promise.all([
        getVersion(),
        fetch(RELEASES_API, {
          headers: { Accept: 'application/vnd.github+json' },
        }),
      ]);
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      const body = (await res.json()) as { tag_name?: string; name?: string };
      const tag = body.tag_name ?? body.name ?? '';
      if (!tag) throw new Error('no tag in GitHub response');
      if (!mountedRef.current) return;
      const cmp = cmpSemver(currentRaw, tag);
      if (cmp < 0) {
        setState({ kind: 'update', latest: normalise(tag), current: currentRaw });
      } else {
        setState({ kind: 'uptodate', version: currentRaw });
      }
    } catch (e) {
      if (!mountedRef.current) return;
      setState({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="xs" onClick={check} disabled={state.kind === 'checking'}>
        {state.kind === 'checking' ? 'Checking…' : 'Check for updates'}
      </Button>
      {state.kind === 'uptodate' && (
        <span className="t-tertiary text-meta">
          You're on the latest build (v{state.version}).
        </span>
      )}
      {state.kind === 'update' && (
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
        </div>
      )}
      {state.kind === 'error' && (
        <span className="text-meta" style={{ color: '#f87171' }}>
          Check failed: {state.message}
        </span>
      )}
    </div>
  );
};
