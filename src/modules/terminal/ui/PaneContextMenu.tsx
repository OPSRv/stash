import { useEffect } from 'react';

import type { ContextMenuAction } from '../types';

export type PaneContextMenuProps = {
  x: number;
  y: number;
  hasSelection: boolean;
  canSplit: boolean;
  canClosePane: boolean;
  onAction: (a: ContextMenuAction) => void;
  onClose: () => void;
};

type Item =
  | {
      kind: 'item';
      label: string;
      hint?: string;
      action: ContextMenuAction;
      disabled?: boolean;
    }
  | { kind: 'sep' };

/// Right-click menu shown over a pane. Mirrors Warp's selection where
/// we can implement cleanly against an xterm stream; block-level
/// actions (Copy command, Share block, Save workflow…) would need
/// shell-integration hooks and aren't in scope.
export const PaneContextMenu = ({
  x,
  y,
  hasSelection,
  canSplit,
  canClosePane,
  onAction,
  onClose,
}: PaneContextMenuProps) => {
  // Close on outside click or Esc. Delayed one tick so the mousedown
  // that opened the menu doesn't immediately dismiss it.
  useEffect(() => {
    const onDoc = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDoc);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const items: Item[] = [
    { kind: 'item', label: 'Copy', hint: '⌘C', action: 'copy', disabled: !hasSelection },
    { kind: 'item', label: 'Copy all output', action: 'copy-all' },
    { kind: 'item', label: 'Paste', hint: '⌘V', action: 'paste' },
    { kind: 'sep' },
    { kind: 'item', label: 'Find…', hint: '⌘F', action: 'find' },
    { kind: 'item', label: 'Compose prompt…', hint: '⌘⇧E', action: 'compose' },
    { kind: 'item', label: 'Clear scrollback', hint: '⌘K', action: 'clear' },
    { kind: 'sep' },
    { kind: 'item', label: 'Split pane right', hint: '⌘D', action: 'split-right', disabled: !canSplit },
    { kind: 'item', label: 'Split pane down', hint: '⌘⇧D', action: 'split-down', disabled: !canSplit },
    { kind: 'sep' },
    { kind: 'item', label: 'Restart shell', action: 'restart' },
    { kind: 'item', label: 'Close pane', hint: '⌘W', action: 'close-pane', disabled: !canClosePane },
  ];

  // Clamp menu position to viewport so it stays on-screen even near
  // the bottom-right corner of the pane.
  const MENU_W = 220;
  const MENU_H = items.length * 28 + 10;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.min(x, vw - MENU_W - 4);
  const top = Math.min(y, vh - MENU_H - 4);

  return (
    <div
      role="menu"
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        left,
        top,
        width: MENU_W,
        zIndex: 1000,
        background: 'var(--color-bg, #141418)',
        border: '1px solid var(--color-border-hair, rgba(255,255,255,0.08))',
        borderRadius: 6,
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        padding: '4px 0',
        fontSize: 12,
        userSelect: 'none',
      }}
      data-testid="terminal-context-menu"
    >
      {items.map((it, i) =>
        it.kind === 'sep' ? (
          <div
            key={`sep-${i}`}
            style={{
              height: 1,
              margin: '4px 6px',
              background: 'var(--color-border-hair, rgba(255,255,255,0.08))',
            }}
          />
        ) : (
          <div
            key={it.action}
            role="menuitem"
            aria-disabled={it.disabled}
            onMouseDown={(e) => {
              // mousedown so the item wins the race against the
              // outside-click dismiss listener attached above.
              if (it.disabled) return;
              e.preventDefault();
              onAction(it.action);
            }}
            className="flex items-center justify-between"
            style={{
              padding: '4px 10px',
              color: it.disabled
                ? 'var(--color-text-tertiary, rgba(255,255,255,0.35))'
                : 'var(--color-text-primary, #e7e7ea)',
              cursor: it.disabled ? 'default' : 'pointer',
              opacity: it.disabled ? 0.55 : 1,
            }}
            onMouseEnter={(e) => {
              if (!it.disabled) {
                (e.currentTarget as HTMLDivElement).style.background =
                  'rgba(255,255,255,0.06)';
              }
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.background = 'transparent';
            }}
          >
            <span>{it.label}</span>
            {it.hint && (
              <span
                style={{
                  color: 'var(--color-text-tertiary, rgba(255,255,255,0.45))',
                  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                  fontSize: 11,
                }}
              >
                {it.hint}
              </span>
            )}
          </div>
        ),
      )}
    </div>
  );
};
