import type { DevTool } from './types';
import { svgToImageTool } from './tools/svgToImage';
import { jwtTool } from './tools/jwt';
import { diffTool } from './tools/diff';

/// Source-of-truth list of dev tiles in their *default* order. The
/// user can reorder them via drag-n-drop in the grid; the persisted
/// order is layered on top of this list (see `order.ts`) so adding a
/// new tool in code automatically slots it in at the end for existing
/// users instead of jumping to the front.
export const DEV_TOOLS: readonly DevTool[] = [
  svgToImageTool,
  jwtTool,
  diffTool,
];

export const DEV_TOOLS_BY_ID: Record<string, DevTool> = Object.fromEntries(
  DEV_TOOLS.map((t) => [t.id, t]),
);
