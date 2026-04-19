import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ACCENTS, applyTheme, DEFAULT_THEME } from './theme';

describe('applyTheme', () => {
  beforeEach(() => {
    document.documentElement.className = '';
    document.documentElement.removeAttribute('style');
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined as never);
  });

  it('adds dark class in dark mode', () => {
    applyTheme({ ...DEFAULT_THEME, mode: 'dark' });
    const root = document.documentElement;
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.classList.contains('light')).toBe(false);
  });

  it('adds light class in light mode', () => {
    applyTheme({ ...DEFAULT_THEME, mode: 'light' });
    const root = document.documentElement;
    expect(root.classList.contains('light')).toBe(true);
    expect(root.classList.contains('dark')).toBe(false);
  });

  it('writes blur and accent CSS variables', () => {
    applyTheme({ ...DEFAULT_THEME, blur: 20, accent: 'purple' });
    const s = document.documentElement.style;
    expect(s.getPropertyValue('--stash-blur')).toBe('20px');
    expect(s.getPropertyValue('--stash-accent')).toBe(ACCENTS.purple.hex);
    expect(s.getPropertyValue('--stash-accent-rgb')).toBe(ACCENTS.purple.rgb);
  });

  it('clamps blur to 0..60', () => {
    applyTheme({ ...DEFAULT_THEME, blur: -5 });
    expect(document.documentElement.style.getPropertyValue('--stash-blur')).toBe('0px');
    applyTheme({ ...DEFAULT_THEME, blur: 999 });
    expect(document.documentElement.style.getPropertyValue('--stash-blur')).toBe('60px');
  });

  it('clamps paneOpacity to 0..1 and writes the right variable per mode', () => {
    applyTheme({ ...DEFAULT_THEME, mode: 'dark', paneOpacity: 2 });
    expect(
      document.documentElement.style.getPropertyValue('--stash-pane-opacity-dark')
    ).toBe('1.000');
    applyTheme({ ...DEFAULT_THEME, mode: 'light', paneOpacity: -1 });
    expect(
      document.documentElement.style.getPropertyValue('--stash-pane-opacity-light')
    ).toBe('0.000');
  });

  it('pushes blur strength to the native vibrancy command', () => {
    applyTheme({ ...DEFAULT_THEME, blur: 14 });
    expect(invoke).toHaveBeenCalledWith('set_popup_vibrancy', { strength: 14 });
  });

  it('falls back to blue accent for an unknown key', () => {
    // Cast to bypass TS narrowing on the AccentKey union.
    applyTheme({ ...DEFAULT_THEME, accent: 'nonsense' as unknown as typeof DEFAULT_THEME.accent });
    expect(document.documentElement.style.getPropertyValue('--stash-accent')).toBe(
      ACCENTS.blue.hex
    );
  });
});
