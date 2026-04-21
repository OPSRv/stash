/** 500 MiB — threshold for the "heavy tasks only" filter. */
export const HEAVY_RSS_BYTES = 500 * 1024 * 1024;

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
};

export const formatCpu = (pct: number): string =>
  pct >= 10 ? `${pct.toFixed(0)}%` : `${pct.toFixed(1)}%`;
