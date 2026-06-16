import type { ReactNode } from 'react';
import type { ToolKind } from './types';

/** Tool-rail metadata. Icons follow the app's 1.6-stroke / 24-grid language so
 *  they read at the rail's small size. Each bare-icon control is rendered as an
 *  IconButton with this `title` (→ aria-label + Tooltip) per project rules. */
export interface ToolDef {
  kind: ToolKind;
  title: string;
  icon: ReactNode;
  /** Single-key shortcut (no modifier) when the stage is focused. */
  hotkey: string;
}

const S = ({ children }: { children: ReactNode }) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {children}
  </svg>
);

export const TOOLS: ToolDef[] = [
  {
    kind: 'select',
    title: 'Select',
    hotkey: 'v',
    icon: <S><path d="M5 3l6 16 2.5-6.5L20 10z" /></S>,
  },
  {
    kind: 'rect',
    title: 'Rectangle',
    hotkey: 'r',
    icon: <S><rect x="4" y="6" width="16" height="12" rx="1.5" /></S>,
  },
  {
    kind: 'oval',
    title: 'Oval',
    hotkey: 'o',
    icon: <S><ellipse cx="12" cy="12" rx="8" ry="6" /></S>,
  },
  {
    kind: 'line',
    title: 'Line',
    hotkey: 'l',
    icon: <S><path d="M5 19 19 5" /></S>,
  },
  {
    kind: 'arrow',
    title: 'Arrow',
    hotkey: 'a',
    icon: <S><path d="M5 19 19 5M19 5h-6M19 5v6" /></S>,
  },
  {
    kind: 'freehand',
    title: 'Freehand drawing',
    hotkey: 'p',
    icon: <S><path d="M4 16c3 0 3-8 6-8s3 8 6 8 4-4 4-4" /></S>,
  },
  {
    kind: 'text',
    title: 'Text',
    hotkey: 't',
    icon: <S><path d="M5 5h14M12 5v14M9 19h6" /></S>,
  },
  {
    kind: 'highlighter',
    title: 'Highlighter',
    hotkey: 'h',
    icon: <S><path d="M4 20h6M14 4l6 6-9 9-6-1 1-5z" /></S>,
  },
  {
    kind: 'counter',
    title: 'Counter',
    hotkey: 'c',
    icon: <S><circle cx="12" cy="12" r="8" /><path d="M11 9.5 12.5 9v6" /></S>,
  },
  {
    kind: 'blur',
    title: 'Blur',
    hotkey: 'b',
    icon: (
      <S>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <path d="M7 9h.01M11 9h.01M15 9h.01M9 13h.01M13 13h.01M7 17h.01M17 13h.01M11 17h.01" />
      </S>
    ),
  },
  {
    kind: 'erase',
    title: 'Erase area',
    hotkey: 'e',
    icon: <S><path d="M4 16 12 8l5 5-5 5H7zM12 8l4-4 5 5-4 4" /></S>,
  },
  {
    kind: 'eraser',
    title: 'Eraser (brush)',
    hotkey: 'x',
    icon: <S><path d="M7 21h10M5 13l6-6 6 6-5 5H9zM11 7l4-4 6 6-4 4" /></S>,
  },
];

export const TOOL_BY_KIND: Record<ToolKind, ToolDef> = Object.fromEntries(
  TOOLS.map((t) => [t.kind, t]),
) as Record<ToolKind, ToolDef>;

/** Tools that drag out a rectangular bounding box on the stage. */
export const RECT_TOOLS: ToolKind[] = ['rect', 'oval', 'highlighter', 'blur', 'erase'];
/** Tools that drag a single segment. */
export const SEGMENT_TOOLS: ToolKind[] = ['line', 'arrow'];
