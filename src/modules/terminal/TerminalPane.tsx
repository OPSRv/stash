import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
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
  ptyOpen,
  ptyResize,
  ptyWrite,
  terminalSavePasteBlob,
  type DataPayload,
  type ExitPayload,
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
  onSplit?: (orientation: Orientation) => void;
  /// Close control — `undefined` when this is the sole pane of a tab
  /// (the tab-bar × handles that case).
  onClosePane?: () => void;
  /// Pointer-down on the pane's drag handle. Shell's drag manager
  /// opens a pointermove/up machine from there.
  onPaneDragStart?: (e: React.PointerEvent) => void;
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
}: TerminalPaneProps) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const paneRootRef = useRef<HTMLDivElement | null>(null);
  const composeRef = useRef<HTMLTextAreaElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [dead, setDead] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selection, setSelection] = useState('');
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeText, setComposeText] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
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
      fontSize: 12,
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
      await ptyOpen(id, term.cols, term.rows);
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
      const mod = e.metaKey || e.ctrlKey;
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

  // PTY data/exit bus filtered by this pane's id.
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
    return () => {
      unData.then((fn) => fn()).catch(() => {});
      unExit.then((fn) => fn()).catch(() => {});
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

  // --- snippets + commands ------------------------------------------
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

  const restart = useCallback(async () => {
    await ptyClose(id).catch(() => {});
    termRef.current?.clear();
    if (termRef.current && fitRef.current) {
      try {
        await ptyOpen(id, termRef.current.cols, termRef.current.rows);
        setDead(false);
        termRef.current.focus();
      } catch (e) {
        termRef.current.write(`\r\n\x1b[31mrestart failed: ${String(e)}\x1b[0m\r\n`);
      }
    }
  }, [id]);

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
    return '$SHELL';
  }, [dead]);

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
          onSplit?.('row');
          break;
        case 'split-down':
          onSplit?.('column');
          break;
        case 'maximize':
          // Needs a cross-pane registry from the shell to hide siblings;
          // surfaced in the menu as a placeholder for the follow-up task.
          break;
        case 'restart':
          void restart();
          break;
        case 'close-pane':
          onClosePane?.();
          break;
      }
    },
    [onSplit, onClosePane, restart],
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
        onSplit={onSplit}
        onClosePane={onClosePane}
        onPaneDragStart={onPaneDragStart}
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
      </div>
      {contextMenu && (
        <PaneContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          hasSelection={!!selection.trim()}
          canSplit={!!onSplit}
          canClosePane={!!onClosePane}
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
          voice={voice}
          compact={compact}
        />
      )}
    </div>
  );
};
