import { describe, expect, it } from 'vitest';
import { formatBytes } from './bytes';

describe('formatBytes — precise (default)', () => {
  it('formats bytes without decimals', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('formats KB with one decimal when GB is reachable', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(2048)).toBe('2.0 KB');
  });

  it('formats MB with one decimal when GB is reachable', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(512 * 1024 * 1024)).toBe('512.0 MB');
  });

  it('formats GB with two decimals', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.00 GB');
  });

  it('returns "0 B" for null/undefined when no empty fallback set', () => {
    expect(formatBytes(null)).toBe('0 B');
    expect(formatBytes(undefined)).toBe('0 B');
  });
});

describe('formatBytes — empty fallback', () => {
  it('returns empty string for null / undefined / 0 / negatives', () => {
    expect(formatBytes(null, { empty: '' })).toBe('');
    expect(formatBytes(undefined, { empty: '' })).toBe('');
    expect(formatBytes(0, { empty: '' })).toBe('');
    expect(formatBytes(-1, { empty: '' })).toBe('');
  });

  it('supports custom empty placeholder', () => {
    expect(formatBytes(0, { empty: '—' })).toBe('—');
  });
});

describe('formatBytes — stopAt MB (FileChip)', () => {
  it('uses two decimals when MB is the final unit', () => {
    expect(formatBytes(5 * 1024 * 1024, { stopAt: 'MB', empty: '' })).toBe('5.00 MB');
    expect(formatBytes(512, { stopAt: 'MB', empty: '' })).toBe('512 B');
    expect(formatBytes(2048, { stopAt: 'MB', empty: '' })).toBe('2.0 KB');
  });

  it('folds GB-sized input into MB when capped', () => {
    expect(formatBytes(2 * 1024 * 1024 * 1024, { stopAt: 'MB' })).toBe('2048.00 MB');
  });
});

describe('formatBytes — compact (system)', () => {
  it('drops decimals for KB', () => {
    expect(formatBytes(2048, { style: 'compact' })).toBe('2 KB');
  });

  it('uses variable decimals for MB', () => {
    expect(formatBytes(50 * 1024 * 1024, { style: 'compact' })).toBe('50.0 MB');
    expect(formatBytes(600 * 1024 * 1024, { style: 'compact' })).toBe('600 MB');
  });

  it('uses two decimals for GB', () => {
    expect(formatBytes(1500 * 1024 * 1024, { style: 'compact' })).toBe('1.46 GB');
  });

  it('keeps the B row intact', () => {
    expect(formatBytes(512, { style: 'compact' })).toBe('512 B');
  });
});
