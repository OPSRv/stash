import type { TranslationRow } from './api';

export type DateGroup = 'today' | 'yesterday' | 'earlier';

export type GroupedRows = {
  group: DateGroup;
  label: string;
  rows: TranslationRow[];
};

/// Bucket timestamped rows into Today / Yesterday / Earlier. Takes `now` so
/// tests can pin the clock. Order of groups is preserved: today first.
export const groupByDate = (
  rows: TranslationRow[],
  now: number = Date.now() / 1000,
): GroupedRows[] => {
  const startOfDay = (ts: number) => {
    const d = new Date(ts * 1000);
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  };
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - 86_400;
  const today: TranslationRow[] = [];
  const yesterday: TranslationRow[] = [];
  const earlier: TranslationRow[] = [];
  for (const row of rows) {
    if (row.created_at >= todayStart) today.push(row);
    else if (row.created_at >= yesterdayStart) yesterday.push(row);
    else earlier.push(row);
  }
  const out: GroupedRows[] = [];
  if (today.length) out.push({ group: 'today', label: 'Today', rows: today });
  if (yesterday.length) out.push({ group: 'yesterday', label: 'Yesterday', rows: yesterday });
  if (earlier.length) out.push({ group: 'earlier', label: 'Earlier', rows: earlier });
  return out;
};
