import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { setTranslatorSettings, translate } from './api';
import { TARGET_LANGUAGES } from './languages';

describe('translator/api', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined as never);
  });

  it('translate forwards text/to/from', async () => {
    vi.mocked(invoke).mockResolvedValue({
      original: 'hi',
      translated: 'привіт',
      from: 'en',
      to: 'uk',
    } as never);
    const t = await translate('hi', 'uk');
    expect(invoke).toHaveBeenCalledWith('translator_run', { text: 'hi', to: 'uk', from: undefined });
    expect(t.translated).toBe('привіт');
  });

  it('translate passes an explicit source language', async () => {
    await translate('hi', 'uk', 'en');
    expect(invoke).toHaveBeenCalledWith('translator_run', { text: 'hi', to: 'uk', from: 'en' });
  });

  it('setTranslatorSettings forwards enabled/target/minChars', async () => {
    await setTranslatorSettings({ enabled: true, target: 'de', minChars: 10 });
    expect(invoke).toHaveBeenCalledWith('translator_set_settings', {
      enabled: true,
      target: 'de',
      minChars: 10,
    });
  });
});

describe('TARGET_LANGUAGES', () => {
  it('has a non-empty unique ISO-like code list', () => {
    expect(TARGET_LANGUAGES.length).toBeGreaterThan(5);
    const codes = TARGET_LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('does not include Russian per project policy', () => {
    expect(TARGET_LANGUAGES.some((l) => l.code === 'ru')).toBe(false);
  });

  it('exposes English first (matches the default target in settings)', () => {
    expect(TARGET_LANGUAGES[0].code).toBe('en');
  });

  it('includes Ukrainian for Ukrainian-first workflows', () => {
    expect(TARGET_LANGUAGES.some((l) => l.code === 'uk')).toBe(true);
  });
});
