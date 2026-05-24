import { Suspense, useCallback, useEffect, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { CenterSpinner } from '../../shared/ui/CenterSpinner';
import { EmptyState } from '../../shared/ui/EmptyState';
import {
  DEV_OPEN_TOOL_EVENT,
  peekPendingDevTool,
} from './pendingTool';
import { DEV_TOOLS, DEV_TOOLS_BY_ID } from './registry';
import { TileGrid } from './TileGrid';

const ChevronLeft = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M15 6l-6 6 6 6" />
  </svg>
);

const WrenchGlyph = () => (
  <svg
    width="28"
    height="28"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="m6 8 4 4-6 6 2 2 6-6 4 4 4-4-10-10z" />
  </svg>
);

/// Top-level shell for the Dev tab.
///
/// Drill-down navigation: the grid view and the active tool view are
/// mutually exclusive. Clicking a tile flips the shell into the tool
/// view; the "Back" button at the top returns to the grid. Tool
/// components are React.lazy so opening a tile only pays for that
/// chunk on first visit.
export function DevShell() {
  // On first mount, honour any pending tool the shell parked for us
  // (e.g. JWT auto-open). `peek` rather than `take` so the tool view
  // itself can still consume the payload after it lazy-mounts.
  const [activeToolId, setActiveToolId] = useState<string | null>(() => {
    const pending = peekPendingDevTool();
    if (pending && DEV_TOOLS_BY_ID[pending.toolId]) return pending.toolId;
    return null;
  });
  const activeTool = activeToolId ? DEV_TOOLS_BY_ID[activeToolId] : null;

  const openTool = useCallback((id: string) => setActiveToolId(id), []);
  const back = useCallback(() => setActiveToolId(null), []);

  // Live-update path: if the Dev tab is already mounted when the
  // shell decides a tool should open, jump to it without waiting for
  // a remount. Tools also subscribe to the same event so an already-
  // active view can refresh its inputs.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { toolId?: string }
        | undefined;
      if (!detail?.toolId || !DEV_TOOLS_BY_ID[detail.toolId]) return;
      setActiveToolId(detail.toolId);
    };
    window.addEventListener(DEV_OPEN_TOOL_EVENT, handler);
    return () => window.removeEventListener(DEV_OPEN_TOOL_EVENT, handler);
  }, []);

  if (activeTool) {
    const ToolView = activeTool.View;
    return (
      <div className="flex h-full flex-col min-h-0">
        <header className="flex items-center gap-2 px-4 pt-3 pb-2 border-b hair shrink-0">
          <Button
            size="sm"
            variant="ghost"
            onClick={back}
            leadingIcon={<ChevronLeft />}
          >
            Back
          </Button>
          <span className="text-meta t-tertiary">·</span>
          <span className="t-primary text-body font-semibold truncate">
            {activeTool.title}
          </span>
        </header>
        <div className="flex-1 min-h-0 overflow-auto nice-scroll">
          <Suspense fallback={<CenterSpinner />}>
            <ToolView />
          </Suspense>
        </div>
      </div>
    );
  }

  if (DEV_TOOLS.length === 0) {
    return (
      <EmptyState
        glyph
        icon={<WrenchGlyph />}
        title="No dev tools yet"
        description="This tab will fill up as new utilities land. Drop a new tool into src/modules/dev/tools and it will appear here automatically."
      />
    );
  }

  return (
    <div className="h-full overflow-auto nice-scroll p-4">
      <TileGrid tools={DEV_TOOLS} onOpenTool={openTool} />
    </div>
  );
}

export default DevShell;
