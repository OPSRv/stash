import { useCallback, useEffect, useRef, useState } from 'react';
import { loadSettings } from '../../settings/store';
import { userAgentFor } from '../../shared/browserUA';
import { RefreshIcon, TrashIcon } from '../../shared/ui/icons';
import {
  musicClose,
  musicEmbed,
  musicHide,
  musicReload,
  musicStatus,
} from './api';

const toolbarStyle = {
  background: 'var(--color-scrim)',
} as const;

const placeholderStyle = {
  background: 'var(--color-scrim)',
} as const;

/// Renders a thin toolbar plus an invisible sizer that the native child
/// webview positions itself over. `ResizeObserver` keeps the webview in
/// lockstep when the popup repaints; `requestAnimationFrame` also re-runs
/// on every mount so tab switches reposition even when the sizer rect
/// hasn't changed dimensions.
export const MusicShell = () => {
  const sizerRef = useRef<HTMLDivElement | null>(null);
  const [attached, setAttached] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const syncBounds = useCallback(async () => {
    const el = sizerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    try {
      // Derive UA from the single "Default browser" setting so every
      // external web surface identifies the same way.
      const settings = await loadSettings();
      const userAgent = userAgentFor(settings.cookiesFromBrowser);
      await musicEmbed({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        userAgent,
      });
      setAttached(true);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    // On mount: if webview already exists from a previous visit, mark
    // attached immediately so the loading overlay doesn't flash.
    musicStatus()
      .then((s) => {
        if (!cancelled) setAttached(s.attached);
      })
      .catch(() => {});

    // Defer the first embed call until the browser has laid out the sizer.
    // Two rAFs ≈ one full paint cycle — enough for the tab switch's height
    // change to settle before we read getBoundingClientRect.
    let scheduledRaf = requestAnimationFrame(() => {
      scheduledRaf = requestAnimationFrame(() => {
        void syncBounds();
      });
    });

    const el = sizerRef.current;
    const ro = el
      ? new ResizeObserver(() => {
          void syncBounds();
        })
      : null;
    ro?.observe(el!);
    window.addEventListener('resize', syncBounds);

    // Tab switches: PopupShell keeps us mounted (hidden) to preserve state,
    // so unmount cleanup no longer fires on tab change. Track visibility via
    // IntersectionObserver — a `hidden` ancestor collapses our box, so the
    // sizer stops intersecting the viewport. When that happens, hide the
    // native webview; when we become visible again, re-embed at the new rect.
    const io = el
      ? new IntersectionObserver(
          (entries) => {
            const visible = entries[0]?.isIntersecting ?? false;
            if (visible) {
              void syncBounds();
            } else {
              setAttached(false);
              void musicHide().catch(() => {});
            }
          },
          { threshold: 0 },
        )
      : null;
    io?.observe(el!);

    return () => {
      cancelled = true;
      cancelAnimationFrame(scheduledRaf);
      ro?.disconnect();
      io?.disconnect();
      window.removeEventListener('resize', syncBounds);
      // Hide without destroying — login cookies + playback state persist.
      void musicHide().catch(() => {});
    };
  }, [syncBounds]);

  const reload = useCallback(async () => {
    try {
      await musicReload();
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const hardClose = useCallback(async () => {
    try {
      await musicClose();
      setAttached(false);
      // Kick off a fresh embed right away so the user doesn't need to
      // leave and re-enter the tab.
      await syncBounds();
    } catch (e) {
      setError(String(e));
    }
  }, [syncBounds]);

  return (
    <div className="h-full flex flex-col">
      <div
        className="px-3 py-2 flex items-center gap-2 border-b hair"
        style={toolbarStyle}
      >
        <span className="t-primary text-body font-medium">YouTube Music</span>
        <span className="t-tertiary text-meta">music.youtube.com</span>
        <div className="flex-1" />
        {/* Native `title` tooltip (macOS-level surface) — an HTML/DOM
            tooltip would get covered by the child WKWebView that paints
            over this toolbar, so we stick to the OS tooltip here just
            like the main tab bar does. */}
        <button
          type="button"
          onClick={reload}
          aria-label="Reload"
          title="Reload"
          className="w-6 h-6 rounded-md flex items-center justify-center bg-white/[0.04] hover:bg-white/[0.08] t-secondary hover:t-primary transition-colors"
        >
          <RefreshIcon />
        </button>
        <button
          type="button"
          onClick={hardClose}
          aria-label="Sign out & reset"
          title="Sign out & reset"
          className="w-6 h-6 rounded-md flex items-center justify-center bg-white/[0.04] hover:bg-white/[0.08] t-secondary hover:text-red-400 transition-colors"
        >
          <TrashIcon />
        </button>
      </div>
      <div ref={sizerRef} className="flex-1 relative" style={placeholderStyle}>
        {!attached && !error && (
          <div className="absolute inset-0 flex items-center justify-center t-tertiary text-meta">
            Loading YouTube Music…
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
            <div>
              <div className="t-primary text-body font-medium mb-1">
                Couldn't embed the music webview
              </div>
              <div className="t-tertiary text-meta">{error}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
