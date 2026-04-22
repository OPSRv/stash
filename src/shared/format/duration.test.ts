import { describe, expect, it } from 'vitest';
import { formatDuration } from './duration';

describe('formatDuration — seconds (default)', () => {
  it('returns 0:00 for null / undefined / negative when no empty set', () => {
    expect(formatDuration(null)).toBe('0:00');
    expect(formatDuration(undefined)).toBe('0:00');
    expect(formatDuration(-5)).toBe('0:00');
    expect(formatDuration(Number.NaN)).toBe('0:00');
  });

  it('returns empty string with `empty` opt', () => {
    expect(formatDuration(null, { empty: '' })).toBe('');
    expect(formatDuration(0, { empty: '' })).toBe('');
    expect(formatDuration(-1, { empty: '' })).toBe('');
  });

  it('formats short durations as M:SS', () => {
    expect(formatDuration(5, { empty: '' })).toBe('0:05');
    expect(formatDuration(65, { empty: '' })).toBe('1:05');
    expect(formatDuration(125, { empty: '' })).toBe('2:05');
  });

  it('promotes to H:MM:SS when an hour is reached', () => {
    expect(formatDuration(3600, { empty: '' })).toBe('1:00:00');
    expect(formatDuration(3665, { empty: '' })).toBe('1:01:05');
    expect(formatDuration(7325, { empty: '' })).toBe('2:02:05');
  });

  it('rounds fractional seconds', () => {
    expect(formatDuration(5.4, { empty: '' })).toBe('0:05');
    expect(formatDuration(5.6, { empty: '' })).toBe('0:06');
  });
});

describe('formatDuration — milliseconds', () => {
  it('floors ms to the current second (monotonic timer display)', () => {
    expect(formatDuration(999, { unit: 'ms' })).toBe('0:00');
    expect(formatDuration(1000, { unit: 'ms' })).toBe('0:01');
    expect(formatDuration(1999, { unit: 'ms' })).toBe('0:01');
    expect(formatDuration(62_000, { unit: 'ms' })).toBe('1:02');
  });

  it('honours empty placeholder for null / non-positive', () => {
    expect(formatDuration(null, { unit: 'ms', empty: '—' })).toBe('—');
    expect(formatDuration(0, { unit: 'ms', empty: '—' })).toBe('—');
  });
});

describe('formatDuration — includeHours: never', () => {
  it('overflows minutes instead of emitting hours', () => {
    expect(formatDuration(3665, { includeHours: 'never', empty: '' })).toBe('61:05');
    expect(formatDuration(7325, { includeHours: 'never', empty: '' })).toBe('122:05');
  });

  it('handles zero without overflow', () => {
    expect(formatDuration(0, { includeHours: 'never' })).toBe('0:00');
  });
});
