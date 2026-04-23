import { AskAiButton } from '../../../shared/ui/AskAiButton';
import { Button } from '../../../shared/ui/Button';
import { DragDots } from '../../../shared/ui/DragDots';
import { SearchIcon } from '../../../shared/ui/icons';
import type { Orientation } from '../types';
import { HeaderDivider } from './HeaderDivider';

export type Snippet = { id: string; label: string; command: string };

export type PaneHeaderProps = {
  paneId: string;
  /// Hide action labels (icon-only), below ~360 px.
  compact: boolean;
  /// Also hide the `$SHELL` status, below ~220 px.
  ultraCompact: boolean;
  /// Hide the snippet chips, below ~520 px.
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
  onClosePane?: () => void;
  /// Pointer-down on the pane's drag handle; the shell's drag
  /// manager owns the rest of the gesture.
  onPaneDragStart?: (e: React.PointerEvent) => void;
};

/// Pane header: drag-handle, status, snippets, action group. Collapses
/// in stages as the pane narrows so the primary controls (Compose,
/// Find, Restart) always stay reachable.
export const PaneHeader = ({
  paneId,
  compact,
  ultraCompact,
  hideSnippets,
  dead,
  statusLabel,
  snippets,
  runSnippet,
  selection,
  composeOpen,
  toggleCompose,
  onFind,
  onRestart,
  onSplit,
  onClosePane,
  onPaneDragStart,
}: PaneHeaderProps) => {
  const showSnippets = !hideSnippets && snippets.length > 0;
  const showStatus = !ultraCompact;
  const showLabel = !compact;

  return (
    <div
      className="flex items-center gap-1.5 px-2 py-1 shrink-0 border-b hair"
      style={{ minHeight: 28 }}
    >
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
        title="Drag to a tab or another pane to compose layouts"
        data-testid={`terminal-pane-drag-${paneId}`}
      >
        <DragDots />
      </span>

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

      {showSnippets && (
        <div
          className="flex items-center gap-1 min-w-0"
          style={{ overflowX: 'auto' }}
        >
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
        </div>
      )}

      <div className="flex-1" />

      <div className="flex items-center gap-0.5 shrink-0">
        <AskAiButton
          text={() => selection}
          disabled={!selection.trim()}
          title="Ask AI about the selected text"
        />

        {(onSplit || onClosePane) && <HeaderDivider />}

        {onSplit && (
          <>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => onSplit('row')}
              title="Split this tab side-by-side (⌘D)"
              aria-label="Split right"
            >
              ⊟
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => onSplit('column')}
              title="Split this tab top/bottom (⌘⇧D)"
              aria-label="Split down"
            >
              ⊞
            </Button>
          </>
        )}
        {onClosePane && (
          <Button
            size="xs"
            variant="ghost"
            tone="danger"
            onClick={onClosePane}
            title="Close this pane (⌘W)"
            aria-label="Close pane"
          >
            ✕
          </Button>
        )}

        <HeaderDivider />

        <Button
          size="xs"
          variant={composeOpen ? 'soft' : 'ghost'}
          tone={composeOpen ? 'accent' : 'neutral'}
          onClick={toggleCompose}
          title="Multi-line prompt (⌘⇧E)"
          aria-label="Toggle compose"
        >
          {compact ? '✎' : 'Compose'}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={onFind}
          title="Search scrollback (⌘F)"
          aria-label="Find"
          leadingIcon={!compact ? <SearchIcon size={12} /> : undefined}
        >
          {compact ? <SearchIcon size={12} /> : 'Find'}
        </Button>
        <Button
          size="xs"
          variant={dead ? 'soft' : 'ghost'}
          tone={dead ? 'accent' : 'neutral'}
          onClick={onRestart}
          title={dead ? 'Start a fresh shell session' : 'Restart shell'}
          aria-label={dead ? 'Restart shell' : 'Restart'}
        >
          {compact && !dead ? '↻' : dead ? 'Restart shell' : 'Restart'}
        </Button>
      </div>
    </div>
  );
};
