import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';

import { loadSettings, type WebChatService } from '../../settings/store';
import './web-animations.css';
import { userAgentFor } from '../../shared/browserUA';
import { accent } from '../../shared/theme/accent';
import { copyText } from '../../shared/util/clipboard';
import { MoreHorizontalIcon } from '../../shared/ui/icons';
import { Input } from '../../shared/ui/Input';
import { useToast } from '../../shared/ui/Toast';

import { Favicon } from './Favicon';
import type { WebShortcutDetail } from './WebShell';
import { clampZoom, isEmbeddableUrl, ZOOM_STEP } from './webServiceUtils';
import {
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
  /// When set, the overflow menu shows a "Save as tab" entry that reads the
  /// current URL from the embedded webview and forwards it to the parent
  /// so it can prompt the user to pin it as a new `WebChatService`.
  onSaveAsTab?: (currentUrl: string) => void;
  /// Parent-side "pin the current URL as this tab's home URL" hook.
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

/// Arc-style slim toolbar over the native webview: icon-only nav, a URL
/// pill (favicon + host, click to edit), zoom badge, and an overflow (⋯)
/// menu. All prior actions (Copy URL / Open / Pin as home / Save as tab /
/// Reset) moved into the overflow menu so the chrome stays minimal.
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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

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
      if (!(await copyText(current))) throw new Error('clipboard unavailable');
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

  // Close the overflow menu on outside-click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

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

  const host = (() => {
    try {
      return new URL(service.url).hostname;
    } catch {
      return service.url;
    }
  })();

  const runAndClose = (fn: () => void | Promise<unknown>) => () => {
    setMenuOpen(false);
    Promise.resolve(fn()).catch(() => {});
  };

  return (
    <div className="h-full flex flex-col">
      <div
        className="px-2 py-1.5 flex items-center gap-1 border-b hair"
        style={{ background: 'var(--color-bg)' }}
      >
        <NavIconButton onClick={goBack} title="Back (⌘[)" ariaLabel="Back">
          <path d="M9 2 L4 7 L9 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </NavIconButton>
        <NavIconButton onClick={goForward} title="Forward (⌘])" ariaLabel="Forward">
          <path d="M5 2 L10 7 L5 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </NavIconButton>
        <NavIconButton
          onClick={() => {
            reload().catch(() => {});
          }}
          title="Reload (⌘R)"
          ariaLabel="Reload"
        >
          <path
            d="M11.5 4.5 A4 4 0 1 0 12 8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <path d="M11.5 2 V5 H8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </NavIconButton>

        <div
          className="flex-1 min-w-0 mx-1 flex items-center rounded-md"
          style={{ background: 'var(--color-scrim)' }}
        >
          {editingUrl ? (
            <Input
              ref={urlInputRef}
              aria-label="Address bar"
              className="h-7 text-meta flex-1 min-w-0 !bg-transparent border-none"
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
              className="flex items-center gap-2 flex-1 min-w-0 h-7 px-2 text-meta t-secondary hover:t-primary rounded-md text-left"
              title="Edit URL (⌘L)"
            >
              <Favicon url={service.url} label={service.label} size={14} />
              <span className="t-primary font-medium shrink-0">{service.label}</span>
              <span className="t-tertiary truncate">{host}</span>
              {zoom !== 1 && (
                <span className="ml-auto pl-2 t-tertiary tabular-nums shrink-0" title="Zoom — ⌘0 to reset">
                  {zoomLabel}
                </span>
              )}
            </button>
          )}
        </div>

        <div className="relative" ref={menuRef}>
          <button
            type="button"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="w-7 h-7 rounded-md flex items-center justify-center t-secondary hover:t-primary hover:bg-white/[0.06] transition-colors"
            title="More"
          >
            <MoreHorizontalIcon />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full mt-1 min-w-[180px] rounded-md border hair py-1 z-20 shadow-lg"
              style={{ background: 'var(--color-surface)' }}
            >
              <MenuItem onClick={runAndClose(copyUrl)}>Copy URL</MenuItem>
              <MenuItem onClick={runAndClose(openCurrentInBrowser)}>Open in browser</MenuItem>
              {onPinCurrentAsHome && (
                <MenuItem onClick={runAndClose(pinAsHome)}>Pin as home</MenuItem>
              )}
              {onSaveAsTab && (
                <MenuItem onClick={runAndClose(saveAsTab)}>Save as tab</MenuItem>
              )}
              <div className="h-px my-1 mx-1" style={{ background: 'var(--color-hairline)' }} />
              <MenuItem onClick={runAndClose(hardReset)} danger>
                Reset session
              </MenuItem>
            </div>
          )}
        </div>
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
              background: `linear-gradient(90deg, transparent, ${accent(0.9)}, transparent)`,
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

const NavIconButton = ({
  onClick,
  title,
  ariaLabel,
  children,
}: {
  onClick: () => void;
  title: string;
  ariaLabel: string;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={ariaLabel}
    title={title}
    className="w-7 h-7 rounded-md flex items-center justify-center t-secondary hover:t-primary hover:bg-white/[0.06] transition-colors"
  >
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {children}
    </svg>
  </button>
);

const MenuItem = ({
  onClick,
  danger,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    role="menuitem"
    onClick={onClick}
    className={`w-full text-left px-3 py-1.5 text-meta transition-colors ${
      danger
        ? 't-secondary hover:text-red-400 hover:bg-white/[0.04]'
        : 't-secondary hover:t-primary hover:bg-white/[0.04]'
    }`}
  >
    {children}
  </button>
);
