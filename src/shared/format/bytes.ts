/// Canonical byte formatter. Replaces four near-duplicate implementations
/// that used to live in `settings/BackupSection.tsx`, `shared/ui/FileChip.tsx`,
/// `modules/downloader/api.ts`, and `modules/system/format.ts`.
///
/// Two styles cover every existing call site:
/// - `precise` (default) — variable decimals based on where the ladder stops.
///   Non-final non-byte units use 1 decimal; the final (`stopAt`) unit uses 2.
///   Matches the downloader / FileChip conventions.
/// - `compact` — kilobytes without decimals and `≥100 MB` collapses to 0
///   decimals too. Used by the system panels where rows are tight.
///
/// `empty` is opt-in: when set, `null` / `undefined` / values `<= 0` return
/// the provided string instead of `'0 B'`. This preserves the "hide the
/// size slot" behaviour FileChip and the downloader relied on.

export type FormatBytesStopAt = 'KB' | 'MB' | 'GB';
export type FormatBytesStyle = 'precise' | 'compact';

export type FormatBytesOpts = {
  stopAt?: FormatBytesStopAt;
  style?: FormatBytesStyle;
  empty?: string;
};

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

export const formatBytes = (
  n: number | null | undefined,
  opts: FormatBytesOpts = {},
): string => {
  const { stopAt = 'GB', style = 'precise', empty } = opts;

  if (empty !== undefined && (n == null || n <= 0)) return empty;
  if (n == null) return empty ?? '0 B';

  if (n < KB) return `${n} B`;

  if (n < MB || stopAt === 'KB') {
    const v = n / KB;
    if (style === 'compact') return `${v.toFixed(0)} KB`;
    return `${v.toFixed(stopAt === 'KB' ? 2 : 1)} KB`;
  }

  if (n < GB || stopAt === 'MB') {
    const v = n / MB;
    if (style === 'compact') {
      return `${v.toFixed(v >= 100 ? 0 : 1)} MB`;
    }
    return `${v.toFixed(stopAt === 'MB' ? 2 : 1)} MB`;
  }

  const v = n / GB;
  return `${v.toFixed(2)} GB`;
};
