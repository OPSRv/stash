/// Canonical duration formatter. Replaces four near-duplicates that lived in
/// `modules/downloader/api.ts`, `modules/notes/NotesShell.tsx`,
/// `modules/notes/AudioRecorder.tsx`, and `modules/metronome/components/BackingTrack.tsx`.
///
/// Handles both seconds (most APIs) and milliseconds (recording timers).
/// Default format is `M:SS`; if the input reaches an hour and `includeHours`
/// is `'auto'` (the default), the hours column is emitted as `H:MM:SS`.
///
/// `empty` is opt-in. When set, `null` / `undefined` / values `<= 0`
/// return the provided string instead of `0:00`.

export type FormatDurationUnit = 'ms' | 's';
export type FormatDurationHours = 'auto' | 'never';

export type FormatDurationOpts = {
  unit?: FormatDurationUnit;
  empty?: string;
  includeHours?: FormatDurationHours;
};

const pad = (n: number) => n.toString().padStart(2, '0');

export const formatDuration = (
  n: number | null | undefined,
  opts: FormatDurationOpts = {},
): string => {
  const { unit = 's', empty, includeHours = 'auto' } = opts;

  if (empty !== undefined && (n == null || n <= 0 || !Number.isFinite(n))) return empty;
  if (n == null || !Number.isFinite(n) || n < 0) return '0:00';

  // Normalize to whole seconds. Seconds input may be fractional (yt-dlp reports
  // floats), so we round; millisecond input is already integer-grained and we
  // truncate for a monotonic timer display.
  const totalSec = unit === 's' ? Math.round(n) : Math.floor(n / 1000);

  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  if (includeHours === 'auto' && h > 0) {
    return `${h}:${pad(m)}:${pad(s)}`;
  }
  // 'never' drops the hours column entirely and lets minutes overflow.
  const minutes = includeHours === 'never' ? Math.floor(totalSec / 60) : m;
  return `${minutes}:${pad(s)}`;
};
