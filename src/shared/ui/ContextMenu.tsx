import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export type ContextMenuItem =
  | { kind: 'separator' }
  | {
      kind: 'action';
      label: string;
      /// Optional right-side keyboard shortcut hint, rendered muted.
      shortcut?: string;
      /// Optional pre-label leading icon (12 px cluster — reuse
      /// `shared/ui/icons` or module-local icons).
      icon?: ReactNode;
      /// Destructive actions render with a red tint and are separated
      /// from the rest by a visual pause (an implicit separator
      /// above the first danger item if the caller doesn't supply one).
      tone?: 'danger';
      onSelect: () => void;
      /// Disabled actions render greyed-out and skip keyboard focus.
      disabled?: boolean;
    };

type ContextMenuProps = {
  open: boolean;
  /// Viewport-relative coordinates for the cursor. The menu clamps
  /// itself inside the window bounds so a right-click near an edge
  /// still lands fully on-screen.
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  /// aria-label for the popover wrapper. Every menu needs one so
  /// screen readers announce context.
  label: string;
};

// Refresh-2026-04: tightened menu to bundle metrics.
//   - panel padding 4 px (was 6)
//   - item height 24 px (was 28)
//   - separator height 5 px (was 9 — 4 px margin + 0.5 px line + 4 px margin)
const MENU_WIDTH = 220;
const ITEM_HEIGHT = 24;
const SEPARATOR_HEIGHT = 8.5;
const PADDING = 4;

const clampPosition = (x: number, y: number, itemCount: number, separatorCount: number) => {
  const height =
    PADDING * 2 +
    itemCount * ITEM_HEIGHT +
    separatorCount * SEPARATOR_HEIGHT;
  const maxX = window.innerWidth - MENU_WIDTH - 8;
  const maxY = window.innerHeight - height - 8;
  return {
    left: Math.max(8, Math.min(x, maxX)),
    top: Math.max(8, Math.min(y, maxY)),
  };
};

/// Lightweight floating context menu. No portal (keeps it inside the
/// popup's focus scope), auto-positions within the viewport, and
/// supports keyboard nav (↑/↓ to move, Enter to fire, Esc to close).
///
/// We deliberately avoid pulling in a menu library — every primitive
/// the design system needs already exists or lives in one file, and
/// the feature set here (action / separator / danger) is small enough
/// to maintain by hand.
export const ContextMenu = ({ open, x, y, items, onClose, label }: ContextMenuProps) => {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const actionIndexes = items
    .map((it, i) => (it.kind === 'action' && !it.disabled ? i : -1))
    .filter((i) => i !== -1);
  const [activeIdx, setActiveIdx] = useState<number>(actionIndexes[0] ?? -1);

  useEffect(() => {
    if (!open) return;
    setActiveIdx(actionIndexes[0] ?? -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    // Focus the panel so keyboard nav lands here, not on the row
    // underneath (which would still react to Enter / Arrow keys).
    panelRef.current?.focus();

    const onPointerDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) onClose();
    };
    const onScroll = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        const cur = actionIndexes.indexOf(activeIdx);
        if (cur === -1) return;
        const next = (cur + dir + actionIndexes.length) % actionIndexes.length;
        setActiveIdx(actionIndexes[next]);
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        const cur = items[activeIdx];
        if (cur?.kind === 'action' && !cur.disabled) {
          e.preventDefault();
          cur.onSelect();
          onClose();
        }
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose, items, activeIdx, actionIndexes]);

  if (!open) return null;

  const sepCount = items.filter((i) => i.kind === 'separator').length;
  const actCount = items.length - sepCount;
  const { left, top } = clampPosition(x, y, actCount, sepCount);

  return (
    <div
      ref={panelRef}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      // Refresh-2026-04: surface = the shared `.floating-panel` (elevated
      // flat + hairline-strong + drop shadow). The context menu narrows
      // the radius to `--r-md` for a tighter feel; --r-lg from the panel
      // utility would read as a popover card.
      className="floating-panel ctxmenu-panel fixed z-40 outline-none"
      style={{
        left,
        top,
        width: MENU_WIDTH,
        padding: PADDING,
        borderRadius: 'var(--r-lg)',
      }}
    >
      {items.map((it, i) => {
        if (it.kind === 'separator') {
          return (
            <div
              key={`sep-${i}`}
              role="separator"
              className="my-1 mx-0.5 h-px"
              style={{ background: 'var(--hairline)' }}
            />
          );
        }
        const active = i === activeIdx;
        const isDanger = it.tone === 'danger';
        // Refresh-2026-04: hover/active state is a full accent (or danger)
        // flood. This is the loudest single change in the redesign — match
        // macOS native menus exactly.
        const base =
          'ctxmenu-item w-full flex items-center gap-2 px-2 h-6 text-[12.5px] leading-none text-left rounded-[4px] select-none transition-colors';
        const disabled = it.disabled ? 'opacity-40 cursor-not-allowed' : '';
        const itemStyle = active
          ? {
              background: isDanger
                ? 'rgb(var(--color-danger-rgb))'
                : 'rgb(var(--stash-accent-rgb))',
              color: '#ffffff',
            }
          : {
              color: isDanger ? 'var(--color-danger-fg)' : 'var(--fg)',
            };
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            className={`${base} ${disabled}`}
            style={itemStyle}
            onMouseEnter={() => !it.disabled && setActiveIdx(i)}
            onClick={() => {
              if (it.disabled) return;
              it.onSelect();
              onClose();
            }}
          >
            {it.icon && <span className="shrink-0 flex items-center">{it.icon}</span>}
            <span className="flex-1 truncate">{it.label}</span>
            {it.shortcut && (
              <span
                className="text-[10.5px] font-mono tabular-nums"
                style={{ color: active ? 'rgba(255,255,255,0.8)' : 'var(--fg-faint)' }}
              >
                {it.shortcut}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
