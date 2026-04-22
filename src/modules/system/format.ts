import { formatBytes as fmtBytes } from '../../shared/format/bytes';

/** 500 MiB — threshold for the "heavy tasks only" filter. */
export const HEAVY_RSS_BYTES = 500 * 1024 * 1024;

/// Compact-style wrapper — panels render in tight rows, so KB drops decimals
/// and `≥100 MB` rounds to whole numbers. Canonical implementation lives in
/// `src/shared/format/bytes.ts`.
export const formatBytes = (bytes: number): string =>
  fmtBytes(bytes, { style: 'compact' });

export const formatCpu = (pct: number): string =>
  pct >= 10 ? `${pct.toFixed(0)}%` : `${pct.toFixed(1)}%`;
