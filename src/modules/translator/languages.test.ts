import { describe, it, expect } from 'vitest';
import { languageLabel, isRtl, TARGET_LANGUAGES } from './languages';

describe('languageLabel', () => {
  it('returns the curated label for known codes', () => {
    expect(languageLabel('en')).toMatch(/english/i);
    expect(languageLabel('uk')).toBe('Ukrainian');
  });

  it('returns "Auto-detected" for "auto"', () => {
    expect(languageLabel('auto')).toBe('Auto-detected');
  });

  it('falls back to uppercased code for unknown languages', () => {
    expect(languageLabel('zz')).toBe('ZZ');
  });

  it('returns empty string for null/undefined', () => {
    expect(languageLabel(null)).toBe('');
    expect(languageLabel(undefined)).toBe('');
  });
});

describe('isRtl', () => {
  it('is true for Arabic, Hebrew, Farsi, Urdu', () => {
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('he')).toBe(true);
    expect(isRtl('fa')).toBe(true);
    expect(isRtl('ur')).toBe(true);
  });

  it('is false for LTR languages', () => {
    expect(isRtl('en')).toBe(false);
    expect(isRtl('uk')).toBe(false);
  });

  it('is false for null/undefined', () => {
    expect(isRtl(null)).toBe(false);
    expect(isRtl(undefined)).toBe(false);
  });
});

describe('TARGET_LANGUAGES', () => {
  it('has english available as the default target', () => {
    expect(TARGET_LANGUAGES.find((l) => l.code === 'en')).toBeDefined();
  });

  it('does not include Russian per project policy', () => {
    expect(TARGET_LANGUAGES.find((l) => l.code === 'ru')).toBeUndefined();
  });
});
