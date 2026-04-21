import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { openUrl } from '@tauri-apps/plugin-opener';

import { loadSettings, type WebChatService } from '../../settings/store';
import './web-animations.css';
import { userAgentFor } from '../../shared/browserUA';
import { Button } from '../../shared/ui/Button';
import { Input } from '../../shared/ui/Input';
import { useToast } from '../../shared/ui/Toast';

import type { WebShortcutDetail } from './WebShell';
import { clampZoom, isEmbeddableUrl, ZOOM_STEP } from './webServiceUtils';
import {
  faviconUrlFor,
  webchatBack,
  webchatClose,
  webchatCurrentUrl,
  webchatEmbed,
  webchatForward,
  webchatHide,
  webchatReload,
  webchatSetZoom,
} from './webchatApi';

type Props = {
  service: WebChatService;
  /// When set, the toolbar shows a "Save as tab" button that reads the
  /// current URL from the embedded webview and forwards it to the parent
  /// so it can prompt the user to pin it as a new `WebChatService`.
  onSaveAsTab?: (currentUrl: string) => void;
  /// Parent-side "pin the current URL as this tab's home URL" hook. Wired to
  /// a toolbar menu item; the actual persistence happens in WebShell.
  onPinCurrentAsHome?: (currentUrl: string) => void;
  /// Force the native child webview off-screen. Needed whenever HTML
  /// overlays (dialogs, popovers) must appear on top — the native webview
  /// is its own layer and would otherwise cover them.
  suspended?: boolean;
  /// Called when the user bumps zoom via `⌘+ / ⌘- / ⌘0` so the host can
  /// persist the new value on the service record.
  onZoomChange?: (id: string, zoom: number) => void;
};

/// Resolve the "actual" URL we should treat as current. The embedded
/// webview briefly returns `about:blank` during navigation and never returns
/// anything when not yet attached — in both cases the home URL is still a
/// sensible fallback, so the toolbar stays useful.
const pickCurrentUrl = async (serviceId: string, homeUrl: string): Promise<string> => {
  try {
    const current = await webchatCurrentUrl(serviceId);
    return current && current.startsWith('http') ? current : homeUrl;
  } catch {
    return homeUrl;
  }
};

/// Shell for a single web service. Toolbar (nav + label + actions) over a
/// sizer div; the native child webview rides the sizer's geometry. Lifecycle
/// mirrors MusicShell — ResizeObserver/IntersectionObserver for geometry +
/// visibility, cleanup on unmount.
export const EmbeddedWebChat = ({
  service,
  onSaveAsTab,
  onPinCurrentAsHome,
  suspended = false,
  onZoomChange,
}: Props) => {
  const sizerRef = useRef<HTMLDivElement | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const [attached, setAttached] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editingUrl, setEditingUrl] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  // Track zoom locally so keyboard bumps feel instant without round-tripping
  // through a settings reload. Persistence still happens via `onZoomChange`.
  const [zoom, setZoom] = useState<number>(() => clampZoom(service.zoom ?? 1));
  const { toast } = useToast();

  // Reset zoom when switching services — each service keeps its own band.
  useEffect(() => {
    setZoom(clampZoom(service.zoom ?? 1));
  }, [service.id, service.zoom]);

  const syncBounds = useCallback(async () => {
    const el = sizerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    try {
      const settings = await loadSettings();
      const userAgent =
        (service.userAgent && service.userAgent.trim()) ||
        userAgentFor(settings.cookiesFromBrowser);
      await webchatEmbed({
        service: service.id,
        url: service.url,
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        userAgent,
        initialZoom: clampZoom(service.zoom ?? 1),
      });
      setAttached(true);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [service.id, service.url, service.zoom]);

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

  useEffect(() => {
    if (suspended) {
      setAttached(false);
      void webchatHide(service.id).catch(() => {});
    } else {
      void syncBounds();
    }
  }, [suspended, service.id, syncBounds]);

  const reload = useCallback(async () => {
    try {
      await webchatReload(service.id, service.url);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [service.id, service.url]);

  const goBack = useCallback(() => {
    void webchatBack(service.id).catch(() => {});
  }, [service.id]);

  const goForward = useCallback(() => {
    void webchatForward(service.id).catch(() => {});
  }, [service.id]);

  const copyUrl = useCallback(async () => {
    const current = await pickCurrentUrl(service.id, service.url);
    try {
      await writeText(current);
      toast({ title: 'URL copied', description: current, variant: 'success' });
    } catch (e) {
      toast({
        title: 'Could not copy URL',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      });
    }
  }, [service.id, service.url, toast]);

  const openCurrentInBrowser = useCallback(async () => {
    const current = await pickCurrentUrl(service.id, service.url);
    await openUrl(current).catch(() => {});
  }, [service.id, service.url]);

  const saveAsTab = useCallback(async () => {
    if (!onSaveAsTab) return;
    onSaveAsTab(await pickCurrentUrl(service.id, service.url));
  }, [onSaveAsTab, service.id, service.url]);

  const pinAsHome = useCallback(async () => {
    if (!onPinCurrentAsHome) return;
    onPinCurrentAsHome(await pickCurrentUrl(service.id, service.url));
  }, [onPinCurrentAsHome, service.id, service.url]);

  const applyZoom = useCallback(
    (next: number) => {
      const clamped = clampZoom(next);
      setZoom(clamped);
      webchatSetZoom(service.id, clamped).catch(() => {});
      onZoomChange?.(service.id, clamped);
    },
    [onZoomChange, service.id],
  );

  const startEditingUrl = useCallback(async () => {
    const current = await pickCurrentUrl(service.id, service.url);
    setUrlDraft(current);
    setEditingUrl(true);
    // Wait a tick so the input has mounted before we try to select it.
    requestAnimationFrame(() => {
      urlInputRef.current?.focus();
      urlInputRef.current?.select();
    });
  }, [service.id, service.url]);

  const submitUrl = useCallback(async () => {
    const raw = urlDraft.trim();
    if (!raw) {
      setEditingUrl(false);
      return;
    }
    // Let the user type "example.com" without a scheme — same UX as a real
    // browser. Everything else goes through the strict validator.
    const prefixed = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    if (!isEmbeddableUrl(prefixed)) {
      toast({
        title: 'Invalid URL',
        description: 'Must be http:// or https://',
        variant: 'error',
      });
      return;
    }
    try {
      await webchatReload(service.id, prefixed);
      setEditingUrl(false);
    } catch (e) {
      toast({
        title: 'Could not navigate',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      });
    }
  }, [service.id, toast, urlDraft]);

  // Progress bar — driven by `webchat:loading` events emitted from the
  // injected script. We scope by service id so a reload in Gemini does not
  // flicker the bar on the ChatGPT tab if it's in the background.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let endTimer: ReturnType<typeof setTimeout> | null = null;
    listen<{ service: string; state: string }>('webchat:loading', (evt) => {
      if (evt.payload.service !== service.id) return;
      if (evt.payload.state === 'start') {
        if (endTimer) {
          clearTimeout(endTimer);
          endTimer = null;
        }
        setLoading(true);
      } else if (evt.payload.state === 'end') {
        // Delay the hide so the 100% sliver is visible even on fast pages.
        if (endTimer) clearTimeout(endTimer);
        endTimer = setTimeout(() => setLoading(false), 180);
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      if (endTimer) clearTimeout(endTimer);
      unlisten?.();
    };
  }, [service.id]);

  // Host-level shortcut handler. Covers two paths:
  //   1. native webview focused → key forwarded as `stash:web-shortcut`
  //   2. React toolbar focused → window keydown
  // Both converge here so the behaviour stays identical regardless of
  // which layer had focus when the user pressed the combo.
  useEffect(() => {
    const handle = (key: string, shift: boolean, preventDefault?: () => void) => {
      switch (key) {
        case 'r':
          preventDefault?.();
          reload().catch(() => {});
          return true;
        case '[':
          preventDefault?.();
          goBack();
          return true;
        case ']':
          preventDefault?.();
          goForward();
          return true;
        case 'l':
          preventDefault?.();
          startEditingUrl().catch(() => {});
          return true;
        case '=':
        case '+':
          preventDefault?.();
          applyZoom(zoom + ZOOM_STEP);
          return true;
        case '-':
          preventDefault?.();
          // Shift+- is still `-` after lowercasing; treat both the same.
          applyZoom(zoom - ZOOM_STEP);
          return true;
        case '0':
          preventDefault?.();
          applyZoom(1);
          return true;
        default:
          return false;
      }
      // `shift` is unused today but forwarded for future shortcut variants.
      void shift;
    };

    const onDom = (e: Event) => {
      const detail = (e as CustomEvent<WebShortcutDetail>).detail;
      if (!detail || detail.service !== service.id) return;
      handle(detail.key.toLowerCase(), detail.shift);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      const k = e.key.toLowerCase();
      if (handle(k, e.shiftKey, () => e.preventDefault())) {
        e.stopPropagation();
      }
    };
    window.addEventListener('stash:web-shortcut', onDom);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('stash:web-shortcut', onDom);
      window.removeEventListener('keydown', onKey);
    };
  }, [applyZoom, goBack, goForward, reload, service.id, startEditingUrl, zoom]);

  const zoomLabel = useMemo(() => `${Math.round(zoom * 100)}%`, [zoom]);

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
        className="px-2 py-1.5 flex items-center gap-1.5 border-b hair"
        style={{ background: 'var(--color-scrim)' }}
      >
        <Button size="sm" variant="ghost" shape="square" onClick={goBack} aria-label="Back" title="Back">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M9 2 L4 7 L9 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Button>
        <Button size="sm" variant="ghost" shape="square" onClick={goForward} aria-label="Forward" title="Forward">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M5 2 L10 7 L5 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          shape="square"
          onClick={() => {
            reload().catch(() => {});
          }}
          aria-label="Home"
          title="Go to home URL"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M2 7 L7 2 L12 7 M3.5 6 V12 H10.5 V6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Button>
        {favicon && (
          <img
            src={favicon}
            alt=""
            width={16}
            height={16}
            className="rounded-sm ml-1"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
        )}
        <span className="t-primary text-body font-medium shrink-0">{service.label}</span>
        {editingUrl ? (
          <Input
            ref={urlInputRef}
            aria-label="Address bar"
            className="h-6 text-meta flex-1 min-w-0"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.currentTarget.value)}
            onBlur={() => setEditingUrl(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitUrl().catch(() => {});
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setEditingUrl(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              startEditingUrl().catch(() => {});
            }}
            className="t-tertiary text-meta truncate text-left flex-1 min-w-0 hover:t-secondary"
            title="Edit URL (⌘L)"
          >
            {host}
          </button>
        )}
        {zoom !== 1 && !editingUrl && (
          <span
            className="t-tertiary text-meta shrink-0 tabular-nums"
            title="Zoom level — ⌘0 to reset"
          >
            {zoomLabel}
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            copyUrl().catch(() => {});
          }}
          title="Copy current URL"
        >
          Copy URL
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            openCurrentInBrowser().catch(() => {});
          }}
          title="Open current URL in default browser"
        >
          Open
        </Button>
        {onPinCurrentAsHome && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              pinAsHome().catch(() => {});
            }}
            title="Make the current URL this tab's home"
          >
            Pin as home
          </Button>
        )}
        {onSaveAsTab && (
          <Button
            size="sm"
            variant="soft"
            onClick={() => {
              saveAsTab().catch(() => {});
            }}
            title="Pin the current URL as a new tab"
          >
            Save as tab
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          tone="danger"
          onClick={() => {
            hardReset().catch(() => {});
          }}
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
        {loading && (
          <div
            role="progressbar"
            aria-label="Loading"
            className="absolute left-0 top-0 h-0.5 z-10 pointer-events-none"
            style={{
              width: '100%',
              background: 'linear-gradient(90deg, transparent, rgba(var(--stash-accent-rgb), 0.9), transparent)',
              backgroundSize: '40% 100%',
              backgroundRepeat: 'no-repeat',
              animation: 'stash-web-progress 1.1s linear infinite',
            }}
          />
        )}
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
