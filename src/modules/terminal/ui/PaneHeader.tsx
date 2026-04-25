import { useState } from 'react';

import { requestSettingsSection } from '../../../settings/pendingSettingsSection';
import { ContextMenu, type ContextMenuItem } from '../../../shared/ui/ContextMenu';
import { DragDots } from '../../../shared/ui/DragDots';
import { IconButton } from '../../../shared/ui/IconButton';
import { Tooltip } from '../../../shared/ui/Tooltip';
import {
  ClaudeIcon,
  CloseIcon,
  CodeIcon,
  PencilIcon,
  ReuseIcon,
  SearchIcon,
  SplitViewIcon,
} from '../../../shared/ui/icons';
import type { Orientation } from '../types';
import { HeaderDivider } from './HeaderDivider';

export type Snippet = { id: string; label: string; command: string };

export type PaneHeaderProps = {
  paneId: string;
  /// Hide non-essential chrome (labels, status) below ~360 px. Action
  /// buttons are always icon-only now so `compact` no longer changes
  /// their rendering — kept as a prop for the status/label collapse.
  compact: boolean;
  /// Also hide the `$SHELL` status, below ~220 px.
  ultraCompact: boolean;
  /// @deprecated snippets now live in a popover triggered by the
  /// `Commands` button, so header width no longer decides visibility.
  hideSnippets: boolean;
  dead: boolean;
  statusLabel: string;
  snippets: Snippet[];
  runSnippet: (cmd: string) => Promise<void>;
  selection: string;
  composeOpen: boolean;
  toggleCompose: () => void;
  onFind: () => void;
  onRestart: () => void;
  onSplit?: (orientation: Orientation) => void;
  /// Maximize toggle — only passed when the tab has >1 leaves.
  onToggleMaximize?: () => void;
  /// Current maximize state (controls icon + tooltip).
  maximized?: boolean;
  onClosePane?: () => void;
  /// Pointer-down on the pane's drag handle; the shell's drag
  /// manager owns the rest of the gesture.
  onPaneDragStart?: (e: React.PointerEvent) => void;
  /// One-click Claude Code launcher — runs the user's configured
  /// command (default `claude`, overridable in Settings → Terminal so
  /// flags like `--model opus` survive) and opens the Compose box so
  /// a multi-line prompt is ready the moment the CLI takes over the TTY.
  onLaunchClaude?: () => void;
  /// Tooltip shown on the Claude Code button — mirrors the configured
  /// command so users can confirm what will run before clicking.
  claudeCommand?: string;
  /// True when the foreground process in the pane is already `claude`.
  /// Clicking the launcher again would just type `claude\r` into the
  /// running CLI as prompt text, so the button becomes a no-op with a
  /// clarifying tooltip instead.
  claudeRunning?: boolean;
};

/// Pane header: drag-handle, status, snippet-popover trigger, action
/// group, close-on-far-right. All action controls are icon-only for a
/// uniform, quiet header chrome that doesn't compete with xterm output
/// for attention.
export const PaneHeader = ({
  paneId,
  compact,
  ultraCompact,
  dead,
  statusLabel,
  snippets,
  runSnippet,
  composeOpen,
  toggleCompose,
  onFind,
  onRestart,
  onSplit,
  onToggleMaximize,
  maximized = false,
  onClosePane,
  onPaneDragStart,
  onLaunchClaude,
  claudeCommand,
  claudeRunning = false,
}: PaneHeaderProps) => {
  const showStatus = !ultraCompact;
  const showLabel = !compact;
  const hasSnippets = snippets.length > 0;

  const [cmdMenu, setCmdMenu] = useState<{ x: number; y: number } | null>(null);

  const openCmdMenu = (e: React.MouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // Anchor popover below the button, right-aligned so it never
    // clips off the right edge of a narrow pane.
    setCmdMenu({ x: rect.right - 220, y: rect.bottom + 4 });
  };

  const cmdMenuItems: ContextMenuItem[] = [
    ...snippets
      .filter((sn) => sn.command.trim())
      .map<ContextMenuItem>((sn) => ({
        kind: 'action' as const,
        label: sn.label || sn.command,
        shortcut: sn.label ? sn.command : undefined,
        icon: <CodeIcon size={12} />,
        onSelect: () => {
          runSnippet(sn.command).catch(() => {});
        },
        disabled: dead,
      })),
    { kind: 'separator' as const },
    {
      kind: 'action' as const,
      label: 'Manage commands…',
      onSelect: () => {
        requestSettingsSection('terminal');
        window.dispatchEvent(
          new CustomEvent('stash:navigate', { detail: 'settings' }),
        );
      },
    },
  ];

  return (
    <div
      className="flex items-center gap-1 px-2 py-1 shrink-0 border-b hair"
      style={{ minHeight: 28, overflow: 'visible' }}
    >
      <Tooltip label="Drag to a tab or another pane to compose layouts">
        <span
          onPointerDown={(e) => {
            e.stopPropagation();
            onPaneDragStart?.(e);
          }}
          className="t-tertiary inline-flex items-center justify-center select-none"
          style={{
            cursor: 'grab',
            width: 22,
            height: 24,
            flexShrink: 0,
            borderRadius: 4,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLSpanElement).style.background =
              'rgba(255,255,255,0.06)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLSpanElement).style.background = 'transparent';
          }}
          data-testid={`terminal-pane-drag-${paneId}`}
        >
          <DragDots />
        </span>
      </Tooltip>

      {showLabel && (
        <span className="t-tertiary text-meta select-none">Terminal</span>
      )}
      {showStatus && (
        <>
          {showLabel && <span className="t-tertiary text-meta">·</span>}
          <span
            className="text-meta font-mono"
            style={{
              color: dead ? 'var(--color-warning-fg)' : undefined,
              maxWidth: 80,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {statusLabel}
          </span>
        </>
      )}

      <div className="flex-1" />

      <div className="flex items-center gap-0.5 shrink-0">
        {onSplit && (
          <>
            <IconButton onClick={() => onSplit('row')} title="Split side-by-side (⌘D)">
              <SplitViewIcon size={13} />
            </IconButton>
            <IconButton onClick={() => onSplit('column')} title="Split top/bottom (⌘⇧D)">
              <SplitViewIcon size={13} className="rotate-90" />
            </IconButton>
            {onToggleMaximize && (
              <IconButton
                onClick={onToggleMaximize}
                active={maximized}
                title={maximized ? 'Restore layout (⌘E)' : 'Maximize pane (⌘E)'}
              >
                <svg
                  width={13}
                  height={13}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {maximized ? (
                    <>
                      <path d="M9 3H3v6" />
                      <path d="M15 3h6v6" />
                      <path d="M3 15v6h6" />
                      <path d="M15 21h6v-6" />
                    </>
                  ) : (
                    <>
                      <path d="M3 9V3h6" />
                      <path d="M21 9V3h-6" />
                      <path d="M3 15v6h6" />
                      <path d="M21 15v6h-6" />
                    </>
                  )}
                </svg>
              </IconButton>
            )}
            <HeaderDivider />
          </>
        )}

        {onLaunchClaude && (
          <IconButton
            onClick={onLaunchClaude}
            disabled={dead || claudeRunning}
            active={claudeRunning}
            title={
              claudeRunning
                ? 'Launch Claude Code — already running in this pane'
                : claudeCommand && claudeCommand.trim()
                  ? `Launch Claude Code (${claudeCommand.trim()}) and open Compose`
                  : 'Launch Claude Code — configure the command in Settings → Terminal'
            }
            data-testid="terminal-launch-claude"
          >
            <ClaudeIcon size={13} />
          </IconButton>
        )}
        <IconButton
          onClick={(e) => (cmdMenu ? setCmdMenu(null) : openCmdMenu(e))}
          active={!!cmdMenu}
          title={
            hasSnippets
              ? `Saved commands (${snippets.length})`
              : 'Commands — add your own in Settings'
          }
        >
          <CodeIcon size={13} />
        </IconButton>
        <ContextMenu
          open={!!cmdMenu}
          x={cmdMenu?.x ?? 0}
          y={cmdMenu?.y ?? 0}
          items={cmdMenuItems}
          onClose={() => setCmdMenu(null)}
          label="Saved terminal commands"
        />

        <IconButton onClick={toggleCompose} active={composeOpen} title="Multi-line prompt (⌘⇧E)">
          <PencilIcon size={13} />
        </IconButton>
        <IconButton onClick={onFind} title="Search scrollback (⌘F)">
          <SearchIcon size={13} />
        </IconButton>
        <IconButton
          onClick={onRestart}
          active={dead}
          title={dead ? 'Start a fresh shell session' : 'Restart shell'}
        >
          <ReuseIcon size={13} />
        </IconButton>

        {onClosePane && (
          <>
            <HeaderDivider />
            <IconButton onClick={onClosePane} tone="danger" title="Close this pane (⌘W)">
              <CloseIcon size={13} />
            </IconButton>
          </>
        )}
      </div>
    </div>
  );
};
