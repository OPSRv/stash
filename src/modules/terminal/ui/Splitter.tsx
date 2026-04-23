import { useCallback, useRef } from 'react';

import type { Orientation } from '../types';

type SplitterProps = {
  orientation: Orientation;
  /// Called during drag with the pointer position expressed as a
  /// 0..100 percent along the direct flex parent's extent. The caller
  /// translates that into new ratios for the two adjacent siblings.
  onDrag: (absolutePct: number) => void;
};

/// Drag-to-resize separator. Reads its immediate flex-parent's bounding
/// rect on each pointermove — no external ref needed. Works uniformly
/// for top-level splits and deeply nested ones (each Split node is its
/// own flex container, so each splitter reports percent of *its* parent).
export const Splitter = ({ orientation, onDrag }: SplitterProps) => {
  const selfRef = useRef<HTMLDivElement | null>(null);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const parent = selfRef.current?.parentElement;
      if (!parent) return;
      const onMove = (ev: MouseEvent) => {
        const rect = parent.getBoundingClientRect();
        const pct =
          orientation === 'row'
            ? ((ev.clientX - rect.left) / rect.width) * 100
            : ((ev.clientY - rect.top) / rect.height) * 100;
        onDrag(Math.max(0, Math.min(100, pct)));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.body.style.cursor =
        orientation === 'row' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [orientation, onDrag],
  );

  return (
    <div
      ref={selfRef}
      role="separator"
      aria-orientation={orientation === 'row' ? 'vertical' : 'horizontal'}
      onMouseDown={onMouseDown}
      className="terminal-splitter"
      style={{
        flex: '0 0 4px',
        alignSelf: 'stretch',
        cursor: orientation === 'row' ? 'col-resize' : 'row-resize',
        background: 'var(--color-border-hair, rgba(255,255,255,0.06))',
        transition: 'background 140ms',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.background =
          'rgba(var(--stash-accent-rgb), 0.45)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.background =
          'var(--color-border-hair, rgba(255,255,255,0.06))';
      }}
    />
  );
};
