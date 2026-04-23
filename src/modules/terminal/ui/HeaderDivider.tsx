/// 1px hair-coloured separator for the pane header's action groups.
/// Same visual weight as the row's border-bottom, so groups read as
/// segments rather than a cluttered row of buttons.
export const HeaderDivider = () => (
  <span
    aria-hidden
    style={{
      width: 1,
      height: 14,
      background: 'var(--color-border-hair, rgba(255,255,255,0.08))',
      flexShrink: 0,
    }}
  />
);
