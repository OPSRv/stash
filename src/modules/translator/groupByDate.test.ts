import { describe, it, expect } from 'vitest';
import { groupByDate } from './groupByDate';
import type { TranslationRow } from './api';

const row = (id: number, created_at: number): TranslationRow => ({
  id,
  original: 'o',
  translated: 't',
  from_lang: 'uk',
  to_lang: 'en',
  created_at,
});

describe('groupByDate', () => {
  // Fixed noon, 2026-01-15 so we don't straddle a DST boundary.
  const now = Math.floor(new Date('2026-01-15T12:00:00Z').getTime() / 1000);
  const startOfToday = Math.floor(new Date('2026-01-15T00:00:00').getTime() / 1000);

  it('buckets today / yesterday / earlier in that order', () => {
    const rows = [
      row(1, startOfToday + 3600), // today
      row(2, startOfToday - 3600), // yesterday
      row(3, startOfToday - 3 * 86_400), // earlier
    ];
    const groups = groupByDate(rows, now);
    expect(groups.map((g) => g.group)).toEqual(['today', 'yesterday', 'earlier']);
    expect(groups[0].rows).toHaveLength(1);
    expect(groups[0].rows[0].id).toBe(1);
  });

  it('skips empty buckets', () => {
    const groups = groupByDate([row(1, startOfToday + 100)], now);
    expect(groups).toHaveLength(1);
    expect(groups[0].group).toBe('today');
  });

  it('returns empty array for empty input', () => {
    expect(groupByDate([], now)).toEqual([]);
  });
});
