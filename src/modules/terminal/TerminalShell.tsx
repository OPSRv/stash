import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Button } from '../../shared/ui/Button';
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
  const [dead, setDead] = useState(false);

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
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    term.onData((data) => {
      ptyWrite(encodeBase64(data)).catch(() => {});
    });
    term.onResize(({ cols, rows }) => {
      ptyResize(cols, rows).catch(() => {});
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
    };
  }, [boot]);

  // Keys pressed inside xterm must not reach the global PopupShell keydown
  // handler — otherwise Escape closes the popup mid-session and ⌘⌥-digit
  // switches tabs instead of being sent to the shell. ⌘K is a Stash-level
  // convenience that clears the visible scrollback.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const stop = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        termRef.current?.clear();
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
      } catch (e) {
        termRef.current.write(`\r\n\x1b[31mrestart failed: ${String(e)}\x1b[0m\r\n`);
      }
    }
  }, []);

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 pt-2 pb-1 flex items-center gap-2 shrink-0 border-b hair">
        <span className="t-tertiary text-meta">Terminal</span>
        <span className="t-tertiary text-meta">·</span>
        <span className="t-tertiary text-meta font-mono">PTY · $SHELL</span>
        <div className="flex-1" />
        {dead && (
          <span
            className="terminal-dead-banner text-meta"
            style={{ color: 'var(--color-warning-fg)' }}
          >
            shell exited
          </span>
        )}
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
        <Button size="xs" variant="ghost" onClick={restart}>
          Restart
        </Button>
      </div>
      <div ref={hostRef} className="terminal-host flex-1" />
    </div>
  );
};
