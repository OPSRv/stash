/// Helper for the `--stash-accent-rgb` CSS variable. The variable carries
/// the current accent colour as a bare `r,g,b` triple so we can compose
/// translucent tints at any opacity without defining a separate CSS var
/// per level. Previously each caller inlined the `rgba(var(...), α)`
/// template, leading to ~60 copies that drifted in spacing.
///
/// Usage:
///   style={{ background: accent(0.18), borderColor: accent(0.22) }}

export const accent = (opacity: number): string =>
  `rgba(var(--stash-accent-rgb), ${opacity})`;

/// Convenience: solid accent colour (opacity 1). Equivalent to
/// `rgb(var(--stash-accent-rgb))` which some existing stylesheets use —
/// kept separate so call sites can make the intent explicit.
export const accentSolid = (): string => 'rgb(var(--stash-accent-rgb))';
