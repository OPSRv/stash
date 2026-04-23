/// Six-dot drag affordance — the universal "this is grabbable" cue
/// (Notion, Linear, every kanban board). `pointer-events: none` on the
/// inner dots is critical for WKWebView: otherwise mousedown on a dot
/// is delivered to *it*, not to the draggable parent, which breaks
/// pointer-based drag handlers that read coordinates off the parent.
///
/// Pure presentational — colour comes from `currentColor`, so the
/// caller controls intensity by setting `color` on a wrapping element.

export type DragDotsProps = {
  /// Side of one dot in px. Default 2.
  dot?: number;
  /// Gap between dots in px. Default 2.
  gap?: number;
  /// Per-dot opacity over `currentColor`. Default 0.6 — same as the
  /// rest of the t-tertiary system text in Stash.
  opacity?: number;
};

export const DragDots = ({ dot = 2, gap = 2, opacity = 0.6 }: DragDotsProps = {}) => (
  <span
    aria-hidden
    style={{
      display: 'inline-grid',
      gridTemplateColumns: `${dot}px ${dot}px`,
      gridTemplateRows: `${dot}px ${dot}px ${dot}px`,
      gap,
      pointerEvents: 'none',
    }}
  >
    {Array.from({ length: 6 }).map((_, i) => (
      <span
        key={i}
        style={{
          width: dot,
          height: dot,
          background: 'currentColor',
          borderRadius: '50%',
          opacity,
        }}
      />
    ))}
  </span>
);
