import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { Button } from '../../shared/ui/Button';
import { AskAiButton } from '../../shared/ui/AskAiButton';
import { SearchIcon, CloseIcon } from '../../shared/ui/icons';
import { accent } from '../../shared/theme/accent';
import { loadSettings } from '../../settings/store';
import { ptyClose, ptyOpen, ptyResize, ptyWrite, type DataPayload, type ExitPayload } from './api';
import './terminal-animations.css';

/// Derive xterm colours from the current `.light` class on <html>, so the
/// terminal blends into either theme rather than staying stuck on dark.
const readAccent = (): string => {
  if (typeof document === 'undefined') return '#2f7ae5';
  const styles = getComputedStyle(document.documentElement);
  const rgb = styles.getPropertyValue('--stash-accent-rgb').trim();
  if (!rgb) return styles.getPropertyValue('--stash-accent').trim() || '#2f7ae5';
  return `rgb(${rgb})`;
};

const themeFor = (isLight: boolean) => ({
  background: 'rgba(0,0,0,0)',
  foreground: isLight ? '#1a1c21' : '#e7e7ea',
  cursor: readAccent(),
  cursorAccent: isLight ? '#ffffff' : '#1a1c21',
  selectionBackground: isLight ? 'rgba(47,122,229,0.25)' : 'rgba(74,139,234,0.35)',
  black: isLight ? '#1a1c21' : '#1a1a1f',
  brightBlack: '#555',
  red: '#e0585b',
  brightRed: '#f87171',
  green: '#35b26a',
  brightGreen: '#43d66b',
  yellow: '#d29922',
  brightYellow: '#fbbf24',
  blue: isLight ? '#2f7ae5' : '#4a8bea',
  brightBlue: '#6aa3ff',
  magenta: '#b36bdf',
  brightMagenta: '#c89aff',
  cyan: '#2aa5a0',
  brightCyan: '#5ad8d2',
  white: isLight ? '#3a3a40' : '#cfcfd4',
  brightWhite: isLight ? '#000' : '#ffffff',
});

/// Decode base64 → raw UTF-8-decoded string for xterm's `write`. xterm.js
/// accepts strings or Uint8Array — we pass Uint8Array so multibyte UTF-8
/// and ANSI control bytes stay intact without an intermediate copy.
const decodeBase64 = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const encodeBase64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};

/// xterm-backed terminal. One persistent PTY session per app lifetime —
/// switching tabs keeps the shell alive (and scrollback intact).
export const TerminalShell = () => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const [dead, setDead] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selection, setSelection] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const boot = useCallback(async () => {
    const host = hostRef.current;
    if (!host) return;
    const isLight = document.documentElement.classList.contains('light');
    const term = new Terminal({
      fontFamily:
        "'SF Mono', ui-monospace, Menlo, 'Liberation Mono', monospace",
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: themeFor(isLight),
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    // Open URLs in the user's default browser via Tauri's opener plugin —
    // a bare `window.open` is a no-op inside the WKWebView popup.
    const webLinks = new WebLinksAddon((_evt, uri) => {
      openUrl(uri).catch(() => {});
    });
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(webLinks);
    term.open(host);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    term.onData((data) => {
      ptyWrite(encodeBase64(data)).catch(() => {});
    });
    term.onResize(({ cols, rows }) => {
      ptyResize(cols, rows).catch(() => {});
    });
    term.onSelectionChange(() => {
      setSelection(term.getSelection());
    });
    // BEL (\x07) is the shell's "I'm done" signal. Users can append
    // `; printf '\a'` to long commands — or rely on programs that ring the
    // bell on failure — to get a native desktop notification when the popup
    // isn't visible.
    term.onBell(() => {
      void notifyCommandDone();
    });

    try {
      await ptyOpen(term.cols, term.rows);
      setDead(false);
    } catch (e) {
      term.write(`\r\n\x1b[31mterminal: ${String(e)}\x1b[0m\r\n`);
      setDead(true);
    }
    term.focus();
  }, []);

  useEffect(() => {
    void boot();
    return () => {
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [boot]);

  // Keys pressed inside xterm must not reach the global PopupShell keydown
  // handler — otherwise Escape closes the popup mid-session and ⌘⌥-digit
  // switches tabs instead of being sent to the shell. ⌘K clears scrollback,
  // ⌘F opens the in-terminal search overlay.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const stop = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        termRef.current?.clear();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
      }
      e.stopPropagation();
    };
    host.addEventListener('keydown', stop);
    return () => host.removeEventListener('keydown', stop);
  }, []);

  // Re-theme live when the user flips Settings → Appearance. We observe
  // the `.light` class on <html> rather than subscribing to the store so
  // this works for both explicit mode changes and the macOS auto watcher.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const isLight = document.documentElement.classList.contains('light');
      termRef.current?.options && (termRef.current.options.theme = themeFor(isLight));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const unData = listen<DataPayload>('terminal:data', (e) => {
      const bytes = decodeBase64(e.payload.data);
      termRef.current?.write(bytes);
    });
    const unExit = listen<ExitPayload>('terminal:exit', () => {
      setDead(true);
    });
    return () => {
      unData.then((fn) => fn()).catch(() => {});
      unExit.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Resize when popup dimensions change. The popup itself is a fixed size
  // (see CLAUDE.md) but tab-switch can momentarily change host height.
  useEffect(() => {
    const onResize = () => fitRef.current?.fit();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Fit once layout settles after first paint so xterm sees the real cell
  // grid (otherwise the first `pty_open` uses 80×24 defaults).
  useEffect(() => {
    const t = setTimeout(() => fitRef.current?.fit(), 60);
    return () => clearTimeout(t);
  }, []);

  // Suppress popup auto-hide while the Terminal tab is mounted — shells
  // (and claude code in particular) briefly pull focus as children spawn,
  // which would otherwise dismiss the popup. Restore on unmount.
  useEffect(() => {
    invoke('set_popup_auto_hide', { enabled: false }).catch(() => {});
    return () => {
      invoke('set_popup_auto_hide', { enabled: true }).catch(() => {});
    };
  }, []);

  const [snippets, setSnippets] = useState<
    { id: string; label: string; command: string }[]
  >([]);
  useEffect(() => {
    const read = () =>
      loadSettings()
        .then((s) => setSnippets(s.terminalSnippets))
        .catch(() => {});
    read();
    window.addEventListener('stash:settings-changed', read);
    return () => window.removeEventListener('stash:settings-changed', read);
  }, []);

  const runSnippet = useCallback(async (command: string) => {
    const cmd = command.trim();
    if (!cmd) return;
    try {
      // Trailing \r mimics Enter. ptyWrite expects base64 on the wire so
      // control bytes forwarded by keystrokes survive round-trip.
      await ptyWrite(encodeBase64(`${cmd}\r`));
      termRef.current?.focus();
    } catch (e) {
      termRef.current?.write(
        `\r\n\x1b[31msnippet failed: ${String(e)}\x1b[0m\r\n`,
      );
    }
  }, []);

  const restart = useCallback(async () => {
    await ptyClose().catch(() => {});
    termRef.current?.clear();
    if (termRef.current && fitRef.current) {
      try {
        await ptyOpen(termRef.current.cols, termRef.current.rows);
        setDead(false);
        termRef.current.focus();
      } catch (e) {
        termRef.current.write(`\r\n\x1b[31mrestart failed: ${String(e)}\x1b[0m\r\n`);
      }
    }
  }, []);

  const runSearch = useCallback((direction: 'next' | 'prev', query?: string) => {
    const q = query ?? searchQuery;
    if (!q) return;
    const opts = { caseSensitive: false, wholeWord: false, regex: false };
    if (direction === 'next') searchRef.current?.findNext(q, opts);
    else searchRef.current?.findPrevious(q, opts);
  }, [searchQuery]);

  const closeSearch = useCallback(() => {
    searchRef.current?.clearDecorations();
    setSearchOpen(false);
    setSearchQuery('');
    termRef.current?.focus();
  }, []);

  const statusLabel = useMemo(() => {
    if (dead) return 'shell exited';
    return '$SHELL';
  }, [dead]);

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 pt-2 pb-1 flex items-center gap-2 shrink-0 border-b hair">
        <span className="t-tertiary text-meta">Terminal</span>
        <span className="t-tertiary text-meta">·</span>
        <span
          className="text-meta font-mono"
          style={{
            color: dead ? 'var(--color-warning-fg)' : undefined,
          }}
        >
          {statusLabel}
        </span>
        <div className="flex-1" />
        {snippets.map((sn) => (
          <Button
            key={sn.id}
            size="xs"
            variant="soft"
            tone="accent"
            onClick={() => {
              runSnippet(sn.command).catch(() => {});
            }}
            disabled={dead || !sn.command.trim()}
            title={`Send: ${sn.command}`}
          >
            {sn.label}
          </Button>
        ))}
        <div className="w-px h-4 bg-white/[0.08]" aria-hidden />
        <AskAiButton
          text={() => selection}
          disabled={!selection.trim()}
          title="Ask AI about the selected text (opens a new chat)"
        />
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setSearchOpen((v) => !v)}
          title="Search scrollback (⌘F)"
          leadingIcon={<SearchIcon size={12} />}
        >
          Find
        </Button>
        <Button
          size="xs"
          variant={dead ? 'soft' : 'ghost'}
          tone={dead ? 'accent' : 'neutral'}
          onClick={restart}
          title={dead ? 'Start a fresh shell session' : 'Kill the current shell and spawn a new one'}
        >
          {dead ? 'Restart shell' : 'Restart'}
        </Button>
      </div>
      {searchOpen && (
        <div
          className="px-3 py-1.5 flex items-center gap-2 border-b hair"
          style={{ background: 'rgba(255,255,255,0.02)' }}
        >
          <SearchIcon size={12} className="t-tertiary" />
          <input
            ref={searchInputRef}
            type="search"
            value={searchQuery}
            placeholder="Search terminal output"
            onChange={(e) => {
              setSearchQuery(e.target.value);
              runSearch('next', e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                runSearch(e.shiftKey ? 'prev' : 'next');
              } else if (e.key === 'Escape') {
                e.preventDefault();
                closeSearch();
              }
            }}
            className="flex-1 bg-transparent outline-none text-body t-primary"
            data-testid="terminal-search-input"
          />
          <Button size="xs" variant="ghost" onClick={() => runSearch('prev')}>
            Prev
          </Button>
          <Button size="xs" variant="ghost" onClick={() => runSearch('next')}>
            Next
          </Button>
          <button
            type="button"
            onClick={closeSearch}
            aria-label="Close search"
            className="w-6 h-6 rounded-md flex items-center justify-center t-tertiary hover:t-primary hover:bg-white/[0.06]"
          >
            <CloseIcon size={10} />
          </button>
        </div>
      )}
      {dead && (
        <div
          className="px-3 py-2 flex items-center gap-3 text-meta border-b hair"
          style={{
            background: accent(0.08),
            color: 'var(--color-warning-fg)',
          }}
        >
          <span className="terminal-dead-banner font-medium">Shell has exited.</span>
          <span className="t-tertiary">
            Press <kbd className="kbd">Restart</kbd> above, or ⌘-click the banner to relaunch.
          </span>
          <div className="flex-1" />
          <Button size="xs" variant="soft" tone="accent" onClick={restart}>
            Restart shell
          </Button>
        </div>
      )}
      <div ref={hostRef} className="terminal-host flex-1" />
    </div>
  );
};

/** Fire a native desktop notification when a BEL byte arrives from the PTY.
 *  We request permission lazily on first use and cache the result — no toast
 *  inside the app since the whole point is being informed while the popup
 *  is hidden. */
let notifyPermission: 'granted' | 'denied' | 'unknown' = 'unknown';
const notifyCommandDone = async () => {
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import(
      '@tauri-apps/plugin-notification'
    );
    if (notifyPermission === 'unknown') {
      const granted = await isPermissionGranted();
      notifyPermission = granted
        ? 'granted'
        : (await requestPermission()) === 'granted'
          ? 'granted'
          : 'denied';
    }
    if (notifyPermission !== 'granted') return;
    sendNotification({
      title: 'Terminal',
      body: 'Command finished.',
    });
  } catch {
    /* swallow — notifications are best-effort */
  }
};
