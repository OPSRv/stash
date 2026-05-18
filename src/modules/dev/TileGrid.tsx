import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DevTool } from './types';
import { Tile } from './Tile';
import { useTileReorder } from './hooks/useTileReorder';
import { loadOrder, moveTile, saveOrder } from './order';

type TileGridProps = {
  tools: readonly DevTool[];
  /// Open a tool by id. Surfaced so the parent shell controls the
  /// grid ⇄ tool-view transition rather than the grid owning a stack.
  onOpenTool: (id: string) => void;
  /// Optional initial order — used by Storybook to render a fixed
  /// layout without touching localStorage.
  initialOrder?: readonly string[];
  /// Skip localStorage IO. Storybook flag — production calls leave it
  /// off so user reorders persist across popup re-opens.
  ephemeral?: boolean;
};

/// Grid of `Tile`s with pointer-based reordering. The order is
/// persisted to localStorage under `stash.dev.tileOrder` so the user
/// sees the same layout every time they pop the tab open.
export const TileGrid = ({
  tools,
  onOpenTool,
  initialOrder,
  ephemeral = false,
}: TileGridProps) => {
  const [order, setOrder] = useState<string[]>(() =>
    initialOrder ? [...initialOrder] : loadOrder(tools),
  );

  // Reconcile when the *set* of tools changes (new tool added to
  // registry, etc.) — keep persisted ids that still exist, append
  // unknown ones at the end.
  useEffect(() => {
    setOrder((prev) => {
      const known = new Set(tools.map((t) => t.id));
      const filtered = prev.filter((id) => known.has(id));
      const missing = tools.map((t) => t.id).filter((id) => !filtered.includes(id));
      if (filtered.length === prev.length && missing.length === 0) return prev;
      return [...filtered, ...missing];
    });
  }, [tools]);

  const commit = useCallback(
    (sourceId: string, targetId: string, side: 'before' | 'after') => {
      setOrder((prev) => {
        const next = moveTile(prev, sourceId, targetId, side);
        if (!ephemeral) saveOrder(next);
        return next;
      });
    },
    [ephemeral],
  );

  const { dragState, beginDrag } = useTileReorder(commit);

  const ordered = useMemo(() => {
    const byId = new Map(tools.map((t) => [t.id, t]));
    return order.map((id) => byId.get(id)).filter((t): t is DevTool => !!t);
  }, [order, tools]);

  return (
    <div
      className="grid gap-3"
      style={{
        gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
      }}
    >
      {ordered.map((tool) => {
        const isSource = dragState?.sourceId === tool.id;
        const isTarget = dragState?.targetId === tool.id && !isSource;
        return (
          <Tile
            key={tool.id}
            id={tool.id}
            title={tool.title}
            description={tool.description}
            gradient={tool.gradient}
            icon={tool.icon}
            onOpen={() => onOpenTool(tool.id)}
            onDragStart={beginDrag(tool.id)}
            dragging={isSource}
            dropIndicator={isTarget && dragState ? dragState.side : null}
          />
        );
      })}
    </div>
  );
};
