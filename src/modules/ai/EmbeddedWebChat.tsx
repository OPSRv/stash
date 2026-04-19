import { useCallback, useEffect, useRef, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';

import { loadSettings, type WebChatService } from '../../settings/store';
import { userAgentFor } from '../../shared/browserUA';
import { Button } from '../../shared/ui/Button';

import {
  faviconUrlFor,
  webchatClose,
  webchatEmbed,
  webchatHide,
  webchatReload,
} from './webchatApi';

type Props = {
  service: WebChatService;
};

/// Shell for a single web service. Renders a thin toolbar (label + favicon,
/// Reload, Reset) plus an invisible sizer that the native child webview
/// rides over. Mirrors MusicShell's lifecycle — ResizeObserver for geometry,
/// IntersectionObserver for tab-switch visibility, cleanup on unmount.
export const EmbeddedWebChat = ({ service }: Props) => {
  const sizerRef = useRef<HTMLDivElement | null>(null);
  const [attached, setAttached] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const syncBounds = useCallback(async () => {
    const el = sizerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    try {
      const settings = await loadSettings();
      const userAgent = userAgentFor(settings.cookiesFromBrowser);
      await webchatEmbed({
        service: service.id,
        url: service.url,
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
  }, [service.id, service.url]);

  useEffect(() => {
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
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

    const io = el
      ? new IntersectionObserver(
          (entries) => {
            const visible = entries[0]?.isIntersecting ?? false;
            if (visible) {
              void syncBounds();
            } else {
              setAttached(false);
              void webchatHide(service.id).catch(() => {});
            }
          },
          { threshold: 0 },
        )
      : null;
    io?.observe(el!);

    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      io?.disconnect();
      window.removeEventListener('resize', syncBounds);
      void webchatHide(service.id).catch(() => {});
    };
  }, [service.id, syncBounds]);

  const reload = useCallback(async () => {
    try {
      await webchatReload(service.id, service.url);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [service.id, service.url]);

  const hardReset = useCallback(async () => {
    try {
      await webchatClose(service.id);
      setAttached(false);
      await syncBounds();
    } catch (e) {
      setError(String(e));
    }
  }, [service.id, syncBounds]);

  const favicon = faviconUrlFor(service.url);
  const host = (() => {
    try {
      return new URL(service.url).hostname;
    } catch {
      return service.url;
    }
  })();

  return (
    <div className="h-full flex flex-col">
      <div
        className="px-3 py-2 flex items-center gap-2 border-b hair"
        style={{ background: 'var(--color-scrim)' }}
      >
        {favicon && (
          <img
            src={favicon}
            alt=""
            width={16}
            height={16}
            className="rounded-sm"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
        )}
        <span className="t-primary text-body font-medium">{service.label}</span>
        <span className="t-tertiary text-meta">{host}</span>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="soft"
          onClick={() => openUrl(service.url).catch(() => {})}
          title="Open in your default browser (use when Google blocks embedded sign-in)"
        >
          Open
        </Button>
        <Button size="sm" variant="soft" onClick={reload} title="Reload">
          Reload
        </Button>
        <Button
          size="sm"
          variant="soft"
          tone="danger"
          onClick={hardReset}
          title="Sign out & reset the session"
        >
          Reset
        </Button>
      </div>
      <div
        ref={sizerRef}
        className="flex-1 relative"
        style={{ background: 'var(--color-scrim)' }}
      >
        {!attached && !error && (
          <div className="absolute inset-0 flex items-center justify-center t-tertiary text-meta">
            Loading {service.label}…
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
            <div>
              <div className="t-primary text-body font-medium mb-1">
                Couldn't embed {service.label}
              </div>
              <div className="t-tertiary text-meta">{error}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
