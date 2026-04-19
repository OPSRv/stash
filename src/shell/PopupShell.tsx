import { Suspense, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { modules } from '../modules/registry';
import { SUPPORTED_VIDEO_URL } from '../modules/downloader/downloads.constants';
import { TabButton } from '../shared/ui/TabButton';
import { Button } from '../shared/ui/Button';
import { PinIcon } from '../shared/ui/icons';
import { loadSettings, saveSetting } from '../settings/store';

const MIN_WIDTH = 920;
const MIN_HEIGHT = 520;
import {
  pruneHistory,
  setCookiesBrowser,
  setDownloadsDir,
  setMaxParallel,
  setRateLimit,
} from '../modules/downloader/api';
import { setTranslatorSettings } from '../modules/translator/api';
import { Cheatsheet } from '../shared/ui/Cheatsheet';
import { GlobalSearch } from '../shared/ui/GlobalSearch';
import { TranslationBanner } from '../modules/clipboard/TranslationBanner';
import { NowPlayingBar } from '../modules/music/NowPlayingBar';
import { musicHide, type NowPlaying } from '../modules/music/api';
import { WebchatNowPlayingBar } from '../modules/ai/WebchatNowPlayingBar';
import type { WebchatNowPlaying } from '../modules/ai/webchatApi';
import { applyTheme, subscribeTheme } from '../settings/theme';

export const PopupShell = () => {
  const visibleModules = modules;
  const [activeId, setActiveId] = useState(modules[0]?.id ?? '');
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  // Soft-lazy: once a tab is opened its view stays mounted (hidden when
  // inactive) to preserve state and avoid re-fetches. Tabs that were never
  // opened are never loaded — their JS chunk stays off-heap.
  const [visitedIds, setVisitedIds] = useState<Set<string>>(
    () => new Set(activeId ? [activeId] : []),
  );
  const [translation, setTranslation] = useState<null | {
    original: string;
    translated: string;
    to: string;
  }>(null);
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null);
  const [webchatNp, setWebchatNp] = useState<WebchatNowPlaying | null>(null);
  const [webchatServices, setWebchatServices] = useState<
    { id: string; url: string }[]
  >([]);

  const openTab = (id: string) => {
    setActiveId(id);
    setVisitedIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  };

  // Restore persisted popup size on first mount. Tauri's window defaults to
  // the size declared in tauri.conf.json; if the user stretched it in a
  // previous session, apply the saved logical size here. Saving is wired in
  // a separate effect below, debounced so dragging the edge doesn't hammer
  // the settings file.
  useEffect(() => {
    loadSettings()
      .then(async (s) => {
        const w = Math.max(MIN_WIDTH, s.popupWidth);
        const h = Math.max(MIN_HEIGHT, s.popupHeight);
        if (w > MIN_WIDTH || h > MIN_HEIGHT) {
          try {
            await getCurrentWindow().setSize(new LogicalSize(w, h));
          } catch {
            // Best-effort: the window may not be ready or the API may be
            // unavailable in tests.
          }
        }
      })
      .catch(() => {});
  }, []);

  // Save size on resize, debounced. Tauri emits a Resized event for every
  // frame of a drag, so we coalesce to one settings write ~250ms after the
  // user stops moving the edge. The whole block is wrapped defensively —
  // test stubs of getCurrentWindow() don't implement onResized/scaleFactor.
  useEffect(() => {
    let timer: number | null = null;
    let unlisten: (() => void) | null = null;
    try {
      const win = getCurrentWindow();
      if (typeof win.onResized !== 'function') return;
      win
        .onResized(({ payload }) => {
          if (timer !== null) window.clearTimeout(timer);
          timer = window.setTimeout(async () => {
            try {
              const scale = await win.scaleFactor();
              const w = Math.max(MIN_WIDTH, Math.round(payload.width / scale));
              const h = Math.max(MIN_HEIGHT, Math.round(payload.height / scale));
              await saveSetting('popupWidth', w);
              await saveSetting('popupHeight', h);
            } catch {
              // ignore — resize is a nice-to-have
            }
          }, 250);
        })
        .then((fn) => {
          unlisten = fn;
        })
        .catch(() => {});
    } catch {
      // window API unavailable in this environment
    }
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const read = () => {
      loadSettings()
        .then((s) => {
          setWebchatServices(
            s.aiWebServices.map((w) => ({ id: w.id, url: w.url })),
          );
          applyTheme({
            mode: s.themeMode,
            blur: s.themeBlur,
            paneOpacity: s.themePaneOpacity,
            accent: s.themeAccent,
          });
          return Promise.all([
            setDownloadsDir(s.downloadsFolder),
            setCookiesBrowser(s.cookiesFromBrowser),
            setMaxParallel(s.maxParallelDownloads),
            setRateLimit(s.downloadRateLimit),
            pruneHistory(s.historyRetentionDays),
            setTranslatorSettings({
              enabled: s.translateEnabled,
              target: s.translateTarget,
              minChars: s.translateMinChars,
            }),
          ]);
        })
        .catch(() => {});
    };
    read();
  }, []);

  // Suspend popup auto-hide while the AI tab is active. Chat state
  // transitions (send, stream, disable-while-streaming) briefly blur the
  // popup, and the Rust blur handler would otherwise hide it mid-message.
  useEffect(() => {
    if (activeId === 'ai') {
      invoke('set_popup_auto_hide', { enabled: false }).catch(() => {});
      return () => {
        invoke('set_popup_auto_hide', { enabled: true }).catch(() => {});
      };
    }
  }, [activeId]);

  useEffect(() => {
    const unlisten = subscribeTheme(applyTheme);
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typingInInput =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);
      if (e.key === 'Escape') {
        if (cheatsheetOpen) {
          setCheatsheetOpen(false);
          return;
        }
        getCurrentWindow()
          .hide()
          .catch(() => {});
        return;
      }
      // ⌘⌥1/2/3 switch modules. Each module declares a stable
      // `tabShortcutDigit` so inserting/reordering modules in registry.ts
      // never shifts muscle memory for existing users. Falls back to the
      // positional default for modules that haven't been migrated.
      if (e.metaKey && e.altKey && /^[1-9]$/.test(e.key)) {
        const digit = Number(e.key);
        const target =
          visibleModules.find((m) => m.tabShortcutDigit === digit) ??
          visibleModules[digit - 1];
        if (target) {
          e.preventDefault();
          openTab(target.id);
        }
        return;
      }
      // ? or ⌘/ opens the keyboard cheatsheet.
      if (!typingInInput && (e.key === '?' || (e.metaKey && e.key === '/'))) {
        e.preventDefault();
        setCheatsheetOpen((v) => !v);
      }
      // ⌘⇧F opens unified search across clipboard + downloads + notes.
      if (e.metaKey && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [cheatsheetOpen, visibleModules]);

  // Rust can ask us to activate a specific tab (e.g. ⌘⇧N opens Notes).
  useEffect(() => {
    const unlisten = listen<string>('nav:activate', (e) => {
      if (modules.some((m) => m.id === e.payload)) openTab(e.payload);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // In-app navigation requests (e.g. clipboard → notes after "Save to note").
  useEffect(() => {
    const onNavigate = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (typeof id === 'string' && modules.some((m) => m.id === id)) {
        openTab(id);
      }
    };
    window.addEventListener('stash:navigate', onNavigate);
    return () => window.removeEventListener('stash:navigate', onNavigate);
  }, []);

  // When a new clipboard entry is a downloadable social-media URL, jump the
  // user into the Downloader tab and prefill the URL bar. We re-read the
  // clipboard ourselves because `clipboard:changed` only carries the new row
  // id — reading raw text keeps the handshake simple.
  useEffect(() => {
    const unlisten = listen<number>('clipboard:changed', async () => {
      try {
        const text = (await readText())?.trim();
        if (!text || !SUPPORTED_VIDEO_URL.test(text)) return;
        openTab('downloader');
        window.dispatchEvent(
          new CustomEvent('stash:downloader-prefill', { detail: text }),
        );
      } catch {
        // ignore clipboard read failures — this is a nice-to-have.
      }
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Global listener: translation banner lives at shell level so it renders
  // on every tab, regardless of which module is active when the translation
  // lands. We also unconditionally fire a native notification so the user
  // sees the result even while the popup is hidden.
  useEffect(() => {
    type Payload = {
      id: number;
      original: string;
      translated: string;
      from: string;
      to: string;
    };
    const unlisten = listen<Payload>('clipboard:translated', async (e) => {
      setTranslation({
        original: e.payload.original,
        translated: e.payload.translated,
        to: e.payload.to,
      });
      try {
        const s = await loadSettings();
        if (!s.translateShowNotification) return;
        const {
          isPermissionGranted,
          requestPermission,
          sendNotification,
        } = await import('@tauri-apps/plugin-notification');
        const granted =
          (await isPermissionGranted()) ||
          (await requestPermission()) === 'granted';
        if (granted) {
          sendNotification({
            title: `Translation → ${e.payload.to.toUpperCase()}`,
            body: e.payload.translated,
          });
        }
      } catch (err) {
        console.error('translate notify failed', err);
      }
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Auto-dismiss the banner after a comfortable read — but only if the user
  // hasn't dismissed it manually first. Resets on every new translation.
  useEffect(() => {
    if (!translation) return;
    const t = window.setTimeout(() => setTranslation(null), 12_000);
    return () => window.clearTimeout(t);
  }, [translation]);

  // Music is a native child webview overlay — the React `hidden` attribute
  // collapses its sizer but the native surface keeps rendering over whatever
  // tab is now active. Force-hide it here the moment the user leaves the
  // Music tab so the overlay does not bleed through e.g. Translator.
  useEffect(() => {
    if (activeId !== 'music') {
      musicHide().catch(() => {});
    }
  }, [activeId]);

  // Music webview reports now-playing state every few seconds via the
  // injected poller. We keep the latest snapshot and render a compact bar
  // on every tab (except Music itself) whenever a track is playing.
  useEffect(() => {
    const unlisten = listen<NowPlaying>('music:nowplaying', (e) => {
      setNowPlaying(e.payload);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<WebchatNowPlaying>('webchat:nowplaying', (e) => {
      setWebchatNp(e.payload);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  return (
    <div className="pane h-full w-full rounded-2xl overflow-hidden flex flex-col relative">
      <header
        data-tauri-drag-region
        className="flex items-center gap-1 px-2 py-1.5 border-b hair cursor-grab active:cursor-grabbing"
      >
        {visibleModules.map((m, i) => (
          <TabButton
            key={m.id}
            label={m.title}
            shortcutHint={`⌘⌥${i + 1}`}
            active={m.id === activeId}
            onClick={() => openTab(m.id)}
            onHover={() => m.preloadPopup?.().catch(() => {})}
          />
        ))}
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            shape="square"
            disabled={visitedIds.size <= 1}
            onClick={() => {
              // Reset the visited set to just the active tab. Inactive tab
              // components unmount (their JS stays loaded, but all component
              // state — streaming buffers, virtualised lists, polls, heavy
              // webviews — is released).
              setVisitedIds(new Set(activeId ? [activeId] : []));
            }}
            title="Unload inactive tabs"
            aria-label="Unload inactive tabs"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M11.5 7 A4.5 4.5 0 1 1 7 2.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
              <path
                d="M8.5 1 L11.5 2.5 L10 5.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Button>
          <Button
            size="sm"
            variant={pinned ? 'soft' : 'ghost'}
            tone={pinned ? 'accent' : 'neutral'}
            shape="square"
            onClick={async () => {
              const next = !pinned;
              setPinned(next);
              try {
                await getCurrentWindow().setAlwaysOnTop(next);
              } catch {
                // ignored: window API may be unavailable in tests
              }
              await invoke('set_popup_auto_hide', { enabled: !next }).catch(
                () => {},
              );
            }}
            title={pinned ? 'Unpin window' : 'Pin window on top'}
            aria-label={pinned ? 'Unpin window' : 'Pin window on top'}
            aria-pressed={pinned}
          >
            <PinIcon size={14} filled={pinned} />
          </Button>
        </div>
      </header>
      {(translation ||
        (nowPlaying && nowPlaying.title && activeId !== 'music') ||
        (webchatNp && webchatNp.title && activeId !== 'ai')) && (
        <div className="flex flex-col gap-2 p-2">
          {translation && (
            <TranslationBanner
              original={translation.original}
              translated={translation.translated}
              to={translation.to}
              onDismiss={() => setTranslation(null)}
            />
          )}
          {nowPlaying && nowPlaying.title && activeId !== 'music' && (
            <NowPlayingBar
              state={nowPlaying}
              onOpen={() => openTab('music')}
              onClose={() => setNowPlaying(null)}
              onOptimistic={(patch) =>
                setNowPlaying((prev) => (prev ? { ...prev, ...patch } : prev))
              }
            />
          )}
          {webchatNp && webchatNp.title && activeId !== 'ai' && (
            <WebchatNowPlayingBar
              state={webchatNp}
              serviceUrl={webchatServices.find((w) => w.id === webchatNp.service)?.url}
              onOpen={() => {
                openTab('ai');
                // Tell AiShell which service to surface when it mounts.
                try {
                  localStorage.setItem('stash.ai.lastMode', webchatNp.service);
                } catch {
                  // ignore
                }
                window.dispatchEvent(
                  new CustomEvent('stash:ai-open-service', {
                    detail: webchatNp.service,
                  }),
                );
              }}
              onClose={() => setWebchatNp(null)}
              onOptimistic={(patch) =>
                setWebchatNp((prev) => (prev ? { ...prev, ...patch } : prev))
              }
            />
          )}
        </div>
      )}
      <main className="flex-1 overflow-hidden relative">
        {visibleModules
          .filter((m) => visitedIds.has(m.id) && m.PopupView)
          .map((m) => {
            const View = m.PopupView!;
            const isActive = m.id === activeId;
            return (
              <div
                key={m.id}
                hidden={!isActive}
                className={isActive ? 'h-full w-full' : ''}
              >
                <Suspense
                  fallback={
                    <div className="p-4 t-tertiary text-meta">Loading…</div>
                  }
                >
                  <View />
                </Suspense>
              </div>
            );
          })}
        {!visibleModules.some((m) => m.id === activeId && m.PopupView) && (
          <div className="p-4 t-tertiary text-meta">No view.</div>
        )}
      </main>
      <Cheatsheet
        open={cheatsheetOpen}
        onClose={() => setCheatsheetOpen(false)}
        tab={activeId}
      />
      <GlobalSearch
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onNavigate={(tab) => openTab(tab)}
      />
    </div>
  );
};
