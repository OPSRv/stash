type SeparatorProps = {
  /** `horizontal` is a 0.5 px hairline that fills the cross-axis (used as a
   *  divider between rows of UI). `vertical` is the 16 px tall in-line rule
   *  used to separate clusters of icon buttons in a header. */
  orientation?: 'horizontal' | 'vertical';
  /** `default` reads as `--hairline`; `strong` for places that already sit
   *  on an elevated surface (modal panels, floating bars, segmented controls). */
  tone?: 'default' | 'strong';
  /** Vertical separators have an explicit pixel height. Override when a
   *  cluster needs a taller mark. */
  size?: number;
  className?: string;
};

/** Refresh-2026-04 design-system primitive — every place that hand-rolled
 *  a `<div className="w-px h-5 [background:var(--bg-row-active)]" />` (or sister variants)
 *  should route through this. The component is purely decorative — semantic
 *  structure (sections, lists) shouldn't rely on it for grouping. */
export const Separator = ({
  orientation = 'horizontal',
  tone = 'default',
  size,
  className = '',
}: SeparatorProps) => {
  const colour = tone === 'strong' ? 'var(--hairline-strong)' : 'var(--hairline)';
  const style: React.CSSProperties =
    orientation === 'vertical'
      ? { width: '0.5px', height: size ?? 16, background: colour }
      : { height: '0.5px', width: '100%', background: colour };
  return <span aria-hidden role="separator" className={className} style={style} />;
};
