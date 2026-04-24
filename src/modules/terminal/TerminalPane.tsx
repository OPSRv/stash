import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import './terminal-animations.css';

import { Button } from '../../shared/ui/Button';
import { CloseIcon, SearchIcon } from '../../shared/ui/icons';
import { accent } from '../../shared/theme/accent';
import { loadSettings } from '../../settings/store';
import { useVoiceRecorder } from '../../shared/hooks/useVoiceRecorder';

import {
  ptyClose,
  ptyGetCwd,
  ptyOpen,
  ptyResize,
  ptySetCwd,
  ptyWrite,
  terminalSavePasteBlob,
  type DataPayload,
  type ExitPayload,
  type ProcPayload,
} from './api';
import {
  decodeBase64,
  encodeBase64,
  notifyCommandDone,
  xtermThemeFor,
} from './ui/xtermTheme';
import { ComposeBox } from './ui/ComposeBox';
import { PaneContextMenu } from './ui/PaneContextMenu';
import { PaneHeader } from './ui/PaneHeader';
import type { ContextMenuAction, Orientation } from './types';

export type TerminalPaneProps = {
  /// Stable session id passed to pty_open/write/resize/close. Each pane
  /// owns its own id and filters incoming `terminal:data` events so
  /// panes never consume each other's bytes.
  id: string;
  /// `false` → pane is mounted but hidden via `display:none`. PTY reader
  /// thread keeps running; scrollback and child state survive.
  visible: boolean;
  /// Parent flags this pane as focused — data-attribute only (the
  /// xterm cursor signals focus visually without a coloured ring).
  active: boolean;
  onFocus: () => void;
  /// Parent bumps this every time the tab layout changes so the pane
  /// can re-fit and fire SIGWINCH to alt-screen TUIs.
  layoutRevision: number;
  /// Split controls rendered in the header. `undefined` when the
  /// tab has already reached the pane cap (→ button is hidden).
  /// `sourceCwd` is this pane's live cwd (from OSC 7) so the new
  /// sibling can spawn in the same directory.
  onSplit?: (orientation: Orientation, sourceCwd: string) => void;
  /// Directory the PTY should spawn in on the initial boot. Set by
  /// the shell for panes created via split so they inherit the
  /// source pane's cwd. Ignored on restart (Rust remembers the
  /// last OSC 7 itself).
  initialCwd?: string | null;
  /// Close control — `undefined` when this is the sole pane of a tab
  /// (the tab-bar × handles that case).
  onClosePane?: () => void;
  /// Pointer-down on the pane's drag handle. Shell's drag manager
  /// opens a pointermove/up machine from there.
  onPaneDragStart?: (e: React.PointerEvent) => void;
  /// Toggle full-tab zoom (maximize). Undefined when there's only one
  /// leaf in the tab (nothing to zoom against).
  onToggleMaximize?: () => void;
  /// True while this pane is the zoom target.
  maximized?: boolean;
  /// xterm font size in pixels. Driven by the shell-level ⌘+/⌘−/⌘0
  /// shortcuts. Re-applied live — the pane refits after each change
  /// so the PTY sees a fresh SIGWINCH.
  fontSize: number;
};

/// xterm-backed terminal pane. One persistent PTY session per id, kept
/// alive across tab switches and layout changes.
export const TerminalPane = ({
  id,
  visible,
  active,
  onFocus,
  layoutRevision,
  onSplit,
  onClosePane,
  onPaneDragStart,
  onToggleMaximize,
  maximized = false,
  initialCwd,
  fontSize,
}: TerminalPaneProps) => {
  // Captured once — subsequent prop changes must not re-seed the PTY
  // (Rust's pty_open is a resize on an existing session, but keeping
  // the semantic local guards against future refactors).
  const initialCwdRef = useRef<string | null>(initialCwd ?? null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const paneRootRef = useRef<HTMLDivElement | null>(null);
  const composeRef = useRef<HTMLTextAreaElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [dead, setDead] = useState(false);
  /// Live CWD reported by the shell via OSC 7. Seeded empty; filled on
  /// first sequence and kept in sync with every subsequent one. Used by
  /// the header label and forwarded to Rust on Restart.
  const [cwd, setCwd] = useState<string>('');
  /// Live foreground process name (claude, vim, cargo…) pushed by the
  /// Rust poller. Empty string → shell idle prompt.
  const [procName, setProcName] = useState<string>('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selection, setSelection] = useState('');
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeText, setComposeText] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  /// True while an OS drag is hovering over this pane. Drives the drop
  /// overlay. Tauri intercepts native file drops at the webview level,
  /// so the browser's HTMLElement drop events never fire — we subscribe
  /// via `getCurrentWebview().onDragDropEvent` instead.
  const [fileDragOver, setFileDragOver] = useState(false);
  // Pane width drives responsive header. Thresholds:
  //   > 520 px — full header with snippet chips
  //   360-520 — hide snippets, keep button labels
  //   220-360 — icon-only action buttons (compact)
  //   < 220  — also drop the `$SHELL` label (ultra-compact)
  const [paneWidth, setPaneWidth] = useState(0);
  const compact = paneWidth > 0 && paneWidth < 360;
  const ultraCompact = paneWidth > 0 && paneWidth < 220;
  const hideSnippets = paneWidth > 0 && paneWidth < 520;

  // --- xterm bootstrap ---------------------------------------------
  const boot = useCallback(async () => {
    const host = hostRef.current;
    if (!host) return;
    const isLight = document.documentElement.classList.contains('light');
    const term = new Terminal({
      fontFamily:
        "'SF Mono', ui-monospace, Menlo, 'Liberation Mono', monospace",
      fontSize,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      // Option-click/drag forces native xterm selection even when the
      // running TUI has captured the mouse via DECSET 1002/1003.
      macOptionClickForcesSelection: true,
      theme: xtermThemeFor(isLight),
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
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

    // OSC 7 — shells announce cwd via `ESC ] 7 ; file://<host><path> BEL`
    // after every chdir (zsh/bash/fish with the usual chpwd hooks). Parse
    // it here and push to both local state (for the header label) and
    // Rust (so Restart respawns in the same directory).
    term.parser.registerOscHandler(7, (data) => {
      try {
        const url = new URL(data);
        if (url.protocol === 'file:') {
          const path = decodeURIComponent(url.pathname);
          setCwd(path);
          ptySetCwd(id, path).catch(() => {});
        }
      } catch {
        /* malformed OSC 7 — ignore */
      }
      return false; // let xterm keep default processing
    });

    term.onData((data) => {
      ptyWrite(id, encodeBase64(data)).catch(() => {});
    });
    term.onResize(({ cols, rows }) => {
      ptyResize(id, cols, rows).catch(() => {});
    });
    term.onSelectionChange(() => {
      setSelection(term.getSelection());
    });
    // BEL (\x07) is the shell's "I'm done" signal. Native desktop
    // notification when the popup isn't visible.
    term.onBell(() => {
      void notifyCommandDone();
    });

    try {
      await ptyOpen(id, term.cols, term.rows, initialCwdRef.current);
      setDead(false);
    } catch (e) {
      term.write(`\r\n\x1b[31mterminal: ${String(e)}\x1b[0m\r\n`);
      setDead(true);
    }
    term.focus();
  }, [id]);

  useEffect(() => {
    void boot();
    return () => {
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [boot]);

  // Keys pressed inside xterm must not reach the popup-level keydown
  // handler (Escape would close the popup, ⌘⌥-digit would switch tabs).
  // Custom binds: ⌘K clear, ⌘F find, ⌘⇧E compose, ⌘C copy selection,
  // ⌘V paste.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const stop = (e: KeyboardEvent) => {
      // Cmd only — Ctrl chords (^C/^D/^Z/^W) must reach the shell.
      const mod = e.metaKey;
      if (mod && e.key === 'k') {
        e.preventDefault();
        termRef.current?.clear();
      }
      if (mod && e.key === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
      }
      if (mod && e.shiftKey && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        setComposeOpen((v) => {
          const next = !v;
          if (next) {
            requestAnimationFrame(() => composeRef.current?.focus());
          } else {
            termRef.current?.focus();
          }
          return next;
        });
      }
      if (mod && (e.key === 'c' || e.key === 'C')) {
        const sel = termRef.current?.getSelection() ?? '';
        if (sel) {
          e.preventDefault();
          navigator.clipboard.writeText(sel).catch(() => {});
          termRef.current?.clearSelection();
        }
        // else: let ⌘C through so the shell receives ^C (SIGINT).
      }
      if (mod && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) termRef.current?.paste(text);
          })
          .catch(() => {});
      }
      e.stopPropagation();
    };
    host.addEventListener('keydown', stop);
    return () => host.removeEventListener('keydown', stop);
  }, []);

  // Live-retheme when Settings → Appearance flips.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const isLight = document.documentElement.classList.contains('light');
      if (termRef.current?.options) {
        termRef.current.options.theme = xtermThemeFor(isLight);
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);

  // PTY data/exit/proc bus filtered by this pane's id.
  useEffect(() => {
    const unData = listen<DataPayload>('terminal:data', (e) => {
      if (e.payload.id !== id) return;
      const bytes = decodeBase64(e.payload.data);
      termRef.current?.write(bytes);
    });
    const unExit = listen<ExitPayload>('terminal:exit', (e) => {
      if (e.payload.id !== id) return;
      setDead(true);
    });
    const unProc = listen<ProcPayload>('terminal:proc', (e) => {
      if (e.payload.id !== id) return;
      setProcName(e.payload.name);
    });
    return () => {
      unData.then((fn) => fn()).catch(() => {});
      unExit.then((fn) => fn()).catch(() => {});
      unProc.then((fn) => fn()).catch(() => {});
    };
  }, [id]);

  // Track pane width for responsive header.
  useEffect(() => {
    const el = paneRootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPaneWidth(el.clientWidth));
    ro.observe(el);
    setPaneWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Refit on window resize AND on host resize (split flip, compose
  // toggle). Hidden panes report 0×0 and are skipped.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onResize = () => fitRef.current?.fit();
    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(() => {
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        fitRef.current?.fit();
      }
    });
    ro.observe(host);
    return () => {
      window.removeEventListener('resize', onResize);
      ro.disconnect();
    };
  }, []);

  // First-paint refit so pty_open doesn't use 80×24 defaults.
  useEffect(() => {
    const t = setTimeout(() => fitRef.current?.fit(), 60);
    return () => clearTimeout(t);
  }, []);

  // Explicit refit after layout flips — ResizeObserver catches size
  // changes, but alt-screen TUIs (Claude Code, vim) only repaint when
  // SIGWINCH fires during `ptyResize` from xterm's onResize hook.
  useEffect(() => {
    if (layoutRevision === 0) return;
    const host = hostRef.current;
    const t = setTimeout(() => {
      if (host && host.clientWidth > 0 && host.clientHeight > 0) {
        fitRef.current?.fit();
      }
    }, 40);
    return () => clearTimeout(t);
  }, [layoutRevision]);

  // Live font-size updates (⌘+ / ⌘− / ⌘0). Refit after each change so
  // the PTY sees an accurate cols/rows — TUIs like vim / less depend
  // on SIGWINCH landing promptly after a resize.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    requestAnimationFrame(() => fitRef.current?.fit());
  }, [fontSize]);

  // --- snippets + commands ------------------------------------------
  const [snippets, setSnippets] = useState<
    { id: string; label: string; command: string }[]
  >([]);
  const [claudeCommand, setClaudeCommand] = useState<string>('claude');
  useEffect(() => {
    const read = () =>
      loadSettings()
        .then((s) => {
          setSnippets(s.terminalSnippets);
          setClaudeCommand(s.terminalClaudeCommand || 'claude');
        })
        .catch(() => {});
    read();
    window.addEventListener('stash:settings-changed', read);
    return () => window.removeEventListener('stash:settings-changed', read);
  }, []);

  const runSnippet = useCallback(
    async (command: string) => {
      const cmd = command.trim();
      if (!cmd) return;
      try {
        // Trailing \r mimics Enter. ptyWrite expects base64 on the wire
        // so control bytes survive round-trip.
        await ptyWrite(id, encodeBase64(`${cmd}\r`));
        termRef.current?.focus();
      } catch (e) {
        termRef.current?.write(
          `\r\n\x1b[31msnippet failed: ${String(e)}\x1b[0m\r\n`,
        );
      }
    },
    [id],
  );

  const launchClaude = useCallback(async () => {
    const cmd = (claudeCommand || 'claude').trim();
    if (!cmd) return;
    // Open Compose first so a multi-line prompt is ready the moment the
    // Claude CLI takes over the TTY. Focus lands on the composer via the
    // same toggleCompose path used by ⌘⇧E.
    if (!composeOpen) {
      setComposeOpen(true);
      requestAnimationFrame(() => composeRef.current?.focus());
    }
    try {
      await ptyWrite(id, encodeBase64(`${cmd}\r`));
    } catch (e) {
      termRef.current?.write(
        `\r\n\x1b[31mclaude launch failed: ${String(e)}\x1b[0m\r\n`,
      );
    }
  }, [claudeCommand, composeOpen, id]);

  const restart = useCallback(async () => {
    // Reach into Rust first — it remembers the last cwd announced via
    // OSC 7 even after we close the session. Falls back to local state
    // (shells that never emit OSC 7) and finally to $HOME on the Rust
    // side.
    const remembered = await ptyGetCwd(id).catch(() => null);
    const fallback = cwd || remembered || null;
    await ptyClose(id).catch(() => {});
    termRef.current?.clear();
    if (termRef.current && fitRef.current) {
      try {
        await ptyOpen(id, termRef.current.cols, termRef.current.rows, fallback);
        setDead(false);
        termRef.current.focus();
      } catch (e) {
        termRef.current.write(`\r\n\x1b[31mrestart failed: ${String(e)}\x1b[0m\r\n`);
      }
    }
  }, [id, cwd]);

  const runSearch = useCallback(
    (direction: 'next' | 'prev', query?: string) => {
      const q = query ?? searchQuery;
      if (!q) return;
      const opts = { caseSensitive: false, wholeWord: false, regex: false };
      if (direction === 'next') searchRef.current?.findNext(q, opts);
      else searchRef.current?.findPrevious(q, opts);
    },
    [searchQuery],
  );

  const closeSearch = useCallback(() => {
    searchRef.current?.clearDecorations();
    setSearchOpen(false);
    setSearchQuery('');
    termRef.current?.focus();
  }, []);

  // --- compose / voice / file drop ----------------------------------
  const insertAtCursor = useCallback((text: string) => {
    const ta = composeRef.current;
    if (!ta) {
      setComposeText((prev) => (prev ? `${prev} ${text}` : text));
      return;
    }
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const next = ta.value.slice(0, start) + text + ta.value.slice(end);
    setComposeText(next);
    requestAnimationFrame(() => {
      ta.focus();
      const caret = start + text.length;
      ta.setSelectionRange(caret, caret);
    });
  }, []);

  const voice = useVoiceRecorder({
    onTranscript: (text) => {
      if (!composeOpen) setComposeOpen(true);
      insertAtCursor(text);
    },
  });

  /// Insert a shell-ready `@{path}` reference per dropped file into the
  /// composer, opening it if necessary. Finder drops already hand us an
  /// absolute path, so we skip the save-to-tmp round-trip that
  /// clipboard paste needs.
  const attachPaths = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      if (!composeOpen) setComposeOpen(true);
      // Quote paths containing whitespace so the shell can consume them
      // verbatim when the user hits Enter.
      const tokens = paths.map((p) => (/\s/.test(p) ? `@'${p}'` : `@${p}`));
      insertAtCursor(`${tokens.join(' ')} `);
    },
    [composeOpen, insertAtCursor],
  );

  const attachFileBlob = useCallback(
    async (blob: Blob, filename?: string) => {
      if (!blob || blob.size === 0) return;
      // Prefer the filename's extension over the vague mime type;
      // clipboard pastes often ship as application/octet-stream.
      const fromName = filename?.split('.').pop()?.trim().toLowerCase();
      const fromMime = blob.type.split('/').pop()?.split(';')[0]?.trim();
      const typeExt = fromName && fromName.length <= 6 ? fromName : fromMime || 'bin';
      try {
        const buf = new Uint8Array(await blob.arrayBuffer());
        const path = await terminalSavePasteBlob(buf, typeExt);
        insertAtCursor(`@${path} `);
        if (!composeOpen) setComposeOpen(true);
      } catch (e) {
        console.error('terminal: save paste blob failed', e);
      }
    },
    [insertAtCursor, composeOpen],
  );

  // OS drag-drop (Finder → pane). Tauri's WKWebView intercepts native
  // drop events, so we hook into its drag-drop bridge and route the
  // drop to whichever pane sits under the cursor. Position from Tauri
  // is physical pixels; divide by DPR to compare with the browser's
  // logical rect. Listener stays alive for the pane's lifetime; the
  // guard below ignores drops when the pane is hidden (other tab) or
  // the cursor isn't over it (sibling pane in the same split).
  const attachPathsRef = useRef(attachPaths);
  useEffect(() => {
    attachPathsRef.current = attachPaths;
  }, [attachPaths]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    const insideThisPane = (px: number, py: number): boolean => {
      const el = paneRootRef.current;
      if (!el) return false;
      if (el.offsetParent === null) return false; // hidden tab
      const rect = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const x = px / dpr;
      const y = py / dpr;
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === 'enter') {
          if (p.paths.length === 0) return;
          setFileDragOver(insideThisPane(p.position.x, p.position.y));
        } else if (p.type === 'over') {
          setFileDragOver(insideThisPane(p.position.x, p.position.y));
        } else if (p.type === 'leave') {
          setFileDragOver(false);
        } else if (p.type === 'drop') {
          setFileDragOver(false);
          if (p.paths.length === 0) return;
          if (!insideThisPane(p.position.x, p.position.y)) return;
          attachPathsRef.current(p.paths);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* not running under Tauri (e.g. Storybook / tests) */
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const sendCompose = useCallback(
    async (submit: boolean) => {
      const text = composeText;
      if (!text) return;
      const term = termRef.current;
      if (!term) return;
      // term.paste wraps the payload in \e[200~ … \e[201~ when the
      // remote program advertised bracketed paste — same path as ⌘V.
      term.paste(text);
      if (submit) {
        // Small delay so xterm flushes the paste before the submit CR
        // lands. Bracketed paste is processed atomically by the TUI.
        await new Promise((r) => setTimeout(r, 20));
        await ptyWrite(id, encodeBase64('\r')).catch(() => {});
        setComposeText('');
      }
      // Stay in compose so the user can iterate without stealing focus.
      composeRef.current?.focus();
    },
    [composeText, id],
  );

  const statusLabel = useMemo(() => {
    if (dead) return 'shell exited';
    // Foreground process wins — far more useful than "$SHELL" when the
    // user is running claude / vim / cargo. Fall back to a compact CWD
    // basename, then to "shell" when nothing is known yet.
    if (procName) return procName;
    if (cwd) {
      const home = '/Users/';
      const base = cwd.split('/').filter(Boolean).pop() ?? cwd;
      return cwd.startsWith(home) ? `~/${base}` : base;
    }
    return 'shell';
  }, [dead, procName, cwd]);

  const runContextAction = useCallback(
    (action: ContextMenuAction) => {
      setContextMenu(null);
      const term = termRef.current;
      switch (action) {
        case 'copy': {
          const sel = term?.getSelection() ?? '';
          if (sel) navigator.clipboard.writeText(sel).catch(() => {});
          break;
        }
        case 'copy-all': {
          // Dump the entire scrollback so the user can grab a full
          // command's output without manual selection.
          if (!term) break;
          const lines: string[] = [];
          const buf = term.buffer.active;
          for (let i = 0; i < buf.length; i += 1) {
            lines.push(buf.getLine(i)?.translateToString(true) ?? '');
          }
          const text = lines.join('\n').replace(/\n+$/g, '');
          if (text) navigator.clipboard.writeText(text).catch(() => {});
          break;
        }
        case 'paste':
          navigator.clipboard
            .readText()
            .then((t) => t && term?.paste(t))
            .catch(() => {});
          break;
        case 'clear':
          term?.clear();
          break;
        case 'find':
          setSearchOpen(true);
          requestAnimationFrame(() => searchInputRef.current?.focus());
          break;
        case 'compose':
          setComposeOpen(true);
          requestAnimationFrame(() => composeRef.current?.focus());
          break;
        case 'split-right':
          onSplit?.('row', cwd);
          break;
        case 'split-down':
          onSplit?.('column', cwd);
          break;
        case 'maximize':
          onToggleMaximize?.();
          break;
        case 'restart':
          void restart();
          break;
        case 'close-pane':
          onClosePane?.();
          break;
      }
    },
    [onSplit, onClosePane, restart, cwd],
  );

  return (
    <div
      ref={paneRootRef}
      className="flex flex-col"
      data-pane-id={id}
      data-pane-active={active}
      onMouseDownCapture={() => {
        if (!active) onFocus();
      }}
      onFocusCapture={() => {
        if (!active) onFocus();
      }}
      onContextMenu={(e) => {
        // Native right-click menu ("Reload", "Back") is useless inside
        // a terminal — replace it with our own action list.
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY });
        if (!active) onFocus();
      }}
      style={{
        display: visible ? 'flex' : 'none',
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        position: 'relative',
        overflow: 'hidden',
        // Focus ring: a subtle accent inset on the active pane so
        // keyboard input has an obvious destination in split layouts.
        // Inactive panes keep a 1 px neutral divider so siblings read
        // as separate surfaces rather than one continuous blur.
        boxShadow: active
          ? 'inset 0 0 0 1.5px rgba(var(--stash-accent-rgb), 0.55)'
          : 'inset 0 0 0 1px rgba(255, 255, 255, 0.05)',
        transition: 'box-shadow 140ms var(--easing-standard)',
      }}
    >
      <PaneHeader
        paneId={id}
        compact={compact}
        ultraCompact={ultraCompact}
        hideSnippets={hideSnippets}
        dead={dead}
        statusLabel={statusLabel}
        snippets={snippets}
        runSnippet={runSnippet}
        selection={selection}
        composeOpen={composeOpen}
        toggleCompose={() => {
          setComposeOpen((v) => {
            const next = !v;
            if (next) {
              requestAnimationFrame(() => composeRef.current?.focus());
            } else {
              termRef.current?.focus();
            }
            return next;
          });
        }}
        onFind={() => setSearchOpen((v) => !v)}
        onRestart={restart}
        onSplit={onSplit ? (orientation) => onSplit(orientation, cwd) : undefined}
        onToggleMaximize={onToggleMaximize}
        maximized={maximized}
        onClosePane={onClosePane}
        onPaneDragStart={onPaneDragStart}
        onLaunchClaude={launchClaude}
        claudeCommand={claudeCommand}
        claudeRunning={procName.toLowerCase() === 'claude'}
      />
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
      <div
        className="flex-1 relative"
        style={{ minHeight: 0 }}
        data-drop-target={`pane:${id}`}
      >
        <div
          ref={hostRef}
          className="terminal-host"
          style={{ position: 'absolute', inset: 0 }}
        />
        {fileDragOver && (
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
            style={{
              background: accent(0.1),
              border: `2px dashed ${accent(0.7)}`,
              borderRadius: 6,
              zIndex: 10,
            }}
          >
            <div
              className="text-body font-medium"
              style={{
                color: 'var(--stash-accent)',
                background: 'rgba(20, 22, 28, 0.7)',
                padding: '6px 12px',
                borderRadius: 6,
                backdropFilter: 'blur(10px)',
                WebkitBackdropFilter: 'blur(10px)',
              }}
            >
              Drop files → attach to prompt
            </div>
          </div>
        )}
      </div>
      {contextMenu && (
        <PaneContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          hasSelection={!!selection.trim()}
          canSplit={!!onSplit}
          canClosePane={!!onClosePane}
          canMaximize={!!onToggleMaximize}
          maximized={maximized}
          onAction={runContextAction}
          onClose={() => setContextMenu(null)}
        />
      )}
      {composeOpen && (
        <ComposeBox
          ref={composeRef}
          value={composeText}
          onChange={setComposeText}
          onSend={sendCompose}
          onFileAttach={(f) => attachFileBlob(f, f.name)}
          onEscape={() => termRef.current?.focus()}
          onClose={() => {
            setComposeOpen(false);
            termRef.current?.focus();
          }}
          voice={voice}
          compact={compact}
        />
      )}
    </div>
  );
};
