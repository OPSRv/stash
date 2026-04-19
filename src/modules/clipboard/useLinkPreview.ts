import { useEffect, useState } from 'react';
import { linkPreview, type LinkPreview } from './api';

/// Module-level cache so scrolling a long clipboard list doesn't reissue IPC
/// for the same URL. Stores both resolved values (preview or null=miss) and
/// in-flight promises, which lets concurrent rows share a single fetch.
const cache = new Map<string, LinkPreview | null>();
const inflight = new Map<string, Promise<LinkPreview | null>>();

const resolve = (url: string): Promise<LinkPreview | null> => {
  if (cache.has(url)) return Promise.resolve(cache.get(url) ?? null);
  const existing = inflight.get(url);
  if (existing) return existing;
  const p = linkPreview(url)
    .then((result) => {
      cache.set(url, result);
      return result;
    })
    .catch(() => {
      cache.set(url, null);
      return null;
    })
    .finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
};

/// Lazy-load the link preview for `url`. Pass `enabled=false` to skip the
/// fetch entirely (e.g. when the row is not yet visible). Returns null until
/// the preview resolves; after a miss it stays null.
export const useLinkPreview = (url: string | null, enabled = true): LinkPreview | null => {
  const [value, setValue] = useState<LinkPreview | null>(() =>
    url ? cache.get(url) ?? null : null
  );

  useEffect(() => {
    if (!url || !enabled) return;
    // Already cached? Sync immediately without IPC.
    if (cache.has(url)) {
      setValue(cache.get(url) ?? null);
      return;
    }
    let cancelled = false;
    resolve(url).then((v) => {
      if (!cancelled) setValue(v);
    });
    return () => {
      cancelled = true;
    };
  }, [url, enabled]);

  return value;
};

/// Test-only helpers for resetting module-level state between tests.
export const __resetLinkPreviewCache = () => {
  cache.clear();
  inflight.clear();
};
