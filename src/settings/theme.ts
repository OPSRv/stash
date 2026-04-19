import { invoke } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';

const THEME_EVENT = 'stash:theme-changed';

export type ThemeMode = 'dark' | 'light' | 'auto';

export type AccentKey = 'blue' | 'purple' | 'green' | 'orange' | 'pink' | 'graphite';

export type ThemeSettings = {
  mode: ThemeMode;
  blur: number; // px, 0–60
  paneOpacity: number; // 0.0–1.0; translucency of the popup background
  accent: AccentKey;
};

export const DEFAULT_THEME: ThemeSettings = {
  mode: 'dark',
  blur: 24,
  paneOpacity: 0.35,
  accent: 'blue',
};

export const ACCENTS: Record<AccentKey, { label: string; hex: string; rgb: string }> = {
  blue: { label: 'Blue', hex: '#2F7AE5', rgb: '47, 122, 229' },
  purple: { label: 'Purple', hex: '#8B5CF6', rgb: '139, 92, 246' },
  green: { label: 'Green', hex: '#22C55E', rgb: '34, 197, 94' },
  orange: { label: 'Orange', hex: '#F97316', rgb: '249, 115, 22' },
  pink: { label: 'Pink', hex: '#EC4899', rgb: '236, 72, 153' },
  graphite: { label: 'Graphite', hex: '#6B7280', rgb: '107, 114, 128' },
};

const prefersLight = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: light)').matches;

/// Write the theme to the document root: sets the `.light`/`.dark` class and
/// overrides the `--stash-*` CSS variables used by tokens.css.
export const applyTheme = (t: ThemeSettings) => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const light = t.mode === 'light' || (t.mode === 'auto' && prefersLight());
  root.classList.toggle('light', light);
  root.classList.toggle('dark', !light);
  const blur = Math.max(0, Math.min(60, t.blur));
  root.style.setProperty('--stash-blur', `${blur}px`);
  const opacity = Math.max(0, Math.min(1, t.paneOpacity));
  root.style.setProperty(
    light ? '--stash-pane-opacity-light' : '--stash-pane-opacity-dark',
    opacity.toFixed(3)
  );
  const accent = ACCENTS[t.accent] ?? ACCENTS.blue;
  root.style.setProperty('--stash-accent', accent.hex);
  root.style.setProperty('--stash-accent-rgb', accent.rgb);
  // macOS vibrancy strength — Rust side maps this into an NSVisualEffectMaterial.
  invoke('set_popup_vibrancy', { strength: blur }).catch(() => {});
};

/// Broadcast a theme change to every open Tauri window so floating shells
/// (popup, recorder, notes, music, translator) re-apply CSS vars without
/// needing a restart.
export const broadcastTheme = (t: ThemeSettings) => {
  emit(THEME_EVENT, t).catch(() => {});
};

/// Subscribe to remote theme changes; call from any shell that does not own
/// the Settings window so its document picks up new accent/blur/opacity.
export const subscribeTheme = (onChange: (t: ThemeSettings) => void): Promise<UnlistenFn> =>
  listen<ThemeSettings>(THEME_EVENT, (e) => onChange(e.payload));
