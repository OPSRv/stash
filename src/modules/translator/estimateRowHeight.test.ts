import { describe, it, expect } from 'vitest';
import { estimateTranslationRowHeight } from './estimateRowHeight';
import type { TranslationRow } from './api';

const row = (translated: string): TranslationRow => ({
  id: 1,
  original: 'o',
  translated,
  from_lang: 'uk',
  to_lang: 'en',
  created_at: 0,
});

describe('estimateTranslationRowHeight', () => {
  it('returns a small baseline for short strings', () => {
    expect(estimateTranslationRowHeight(row('hi'))).toBeLessThanOrEqual(96);
    expect(estimateTranslationRowHeight(row('hi'))).toBeGreaterThanOrEqual(72);
  });

  it('grows with translated length but stays within an upper bound', () => {
    const long = 'x'.repeat(600);
    const h = estimateTranslationRowHeight(row(long));
    expect(h).toBeGreaterThan(estimateTranslationRowHeight(row('hi')));
    expect(h).toBeLessThanOrEqual(200);
  });
});
