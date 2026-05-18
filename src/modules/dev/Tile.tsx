import type { PointerEvent, ReactNode } from 'react';
import { DragDots } from '../../shared/ui/DragDots';
import { accent } from '../../shared/theme/accent';

type TileProps = {
  id: string;
  title: string;
  description: string;
  /// Two-colour gradient for the icon tile + background wash. Same
  /// convention as `StatCard` so existing dashboard colours can be
  /// reused without translating palettes.
  gradient: [string, string];
  icon: ReactNode;
  onOpen: () => void;
  onDragStart: (e: PointerEvent<HTMLElement>) => void;
  /// `true` while this tile is the source of the active drag — fades
  /// it so the ghost stands out and the user sees the "lifted" state.
  dragging?: boolean;
  /// `null` when no drop is being targeted at this tile, otherwise
  /// the side the indicator bar should render on. Drives a 2px accent
  /// rule along the matching edge.
  dropIndicator?: 'before' | 'after' | null;
};

/// Dev-tab launcher tile. Reads as a card — gradient-washed
/// background, gradient icon tile, two-line description. Clicking
/// anywhere on the body opens the tool. The DragDots affordance only
/// appears on hover / focus-within so resting tiles stay calm.
export const Tile = ({
  id,
  title,
  description,
  gradient,
  icon,
  onOpen,
  onDragStart,
  dragging = false,
  dropIndicator = null,
}: TileProps) => {
  const [from, to] = gradient;
  return (
    <div
      data-tile-id={id}
      className="group relative"
      style={{ opacity: dragging ? 0.4 : 1 }}
    >
      {dropIndicator && (
        <span
          aria-hidden
          className="absolute top-1 bottom-1 w-[2px] rounded-full"
          style={{
            background: accent(0.9),
            boxShadow: `0 0 0 1px ${accent(0.35)}`,
            left: dropIndicator === 'before' ? -5 : undefined,
            right: dropIndicator === 'after' ? -5 : undefined,
          }}
        />
      )}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${title}`}
        className="w-full text-left rounded-2xl p-3 relative overflow-hidden ring-focus transition-transform active:translate-y-[0.5px]"
        style={{
          background: `linear-gradient(135deg, ${from}1c, ${to}2e)`,
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.07)',
          minHeight: 116,
        }}
      >
        <div
          aria-hidden
          className="absolute -top-6 -right-6 w-24 h-24 rounded-full"
          style={{
            background: `radial-gradient(closest-side, ${to}55, transparent)`,
            filter: 'blur(6px)',
          }}
        />
        <div className="relative flex flex-col h-full gap-2.5">
          <div
            aria-hidden
            className="w-10 h-10 rounded-xl inline-flex items-center justify-center text-white"
            style={{
              background: `linear-gradient(135deg, ${from}, ${to})`,
              boxShadow: `0 6px 18px -6px ${to}, inset 0 0 0 1px rgba(255,255,255,0.2)`,
            }}
          >
            {icon}
          </div>
          <div className="min-w-0">
            <div className="t-primary text-body font-semibold truncate">
              {title}
            </div>
            <div className="t-tertiary text-meta line-clamp-2">
              {description}
            </div>
          </div>
        </div>
      </button>
      {/* Drag handle — hidden until hover/focus to keep tiles quiet at
          rest. `touch-none` so the gesture isn't fought by the OS scroll
          handler on trackpads. */}
      <span
        onPointerDown={onDragStart}
        title={`Reorder ${title}`}
        aria-label={`Reorder ${title}`}
        role="button"
        tabIndex={-1}
        className="absolute top-2 right-2 w-6 h-6 rounded-md inline-flex items-center justify-center cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity touch-none"
        style={{
          background: 'rgba(0,0,0,0.20)',
          color: 'rgba(255,255,255,0.65)',
        }}
      >
        <DragDots />
      </span>
    </div>
  );
};
