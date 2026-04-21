import { invoke } from '@tauri-apps/api/core';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { TAB_ICONS } from './tabIcons';
import { NextIcon, PauseIcon, PlayIcon, PrevIcon } from '../shared/ui/icons';
import { createElement } from 'react';

/// Shape consumed by the Rust `tray_set_menu` command. Field names must
/// match the `TrayModuleItem` struct in `src-tauri/src/tray.rs` exactly.
export type TrayMenuItem = {
  id: string;
  title: string;
  accelerator: string | null;
  icon_png: number[] | null;
};

export type TrayModuleInput = {
  id: string;
  title: string;
  tabShortcutDigit?: number;
};

/// Icons in `TAB_ICONS` use `stroke="currentColor"` because in the popup they
/// inherit the tab bar text colour. Tray context menus render the PNG as-is
/// (muda on macOS does not apply template-mode tinting), so we bake in a
/// mid-grey that stays legible on both light and dark macOS menus without
/// needing to re-render on theme change.
const TRAY_ICON_STROKE = '#8a8a8e';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/// Rasterises a single tab's SVG icon to PNG bytes suitable for the native
/// tray menu. Returns `null` when the environment does not provide `Image`
/// or a 2D canvas context (jsdom in unit tests), letting the caller fall
/// back to a plain text menu item.
export const renderTrayIcon = (id: string, size = 36): Promise<number[] | null> => {
  const node = TAB_ICONS[id];
  if (!node) return Promise.resolve(null);
  return rasteriseSvgNode(node as ReactElement, size);
};

/// Pure shape assembler: pairs the module list with pre-rendered PNG bytes.
/// Extracted so the menu payload contract stays unit-testable without
/// needing a real canvas environment.
export const buildTrayMenuItems = (
  mods: TrayModuleInput[],
  icons: Record<string, number[] | null>
): TrayMenuItem[] =>
  mods.map((m) => ({
    id: m.id,
    title: m.title,
    accelerator:
      typeof m.tabShortcutDigit === 'number'
        ? `CmdOrCtrl+Alt+${m.tabShortcutDigit}`
        : null,
    icon_png: icons[m.id] ?? null,
  }));

const rasteriseSvgNode = async (
  node: ReactElement,
  size = 36
): Promise<number[] | null> => {
  const raw = renderToStaticMarkup(node);
  if (!raw.includes('<svg')) return null;
  const coloured = raw
    .replace(/stroke="currentColor"/g, `stroke="${TRAY_ICON_STROKE}"`)
    .replace(/fill="currentColor"/g, `fill="${TRAY_ICON_STROKE}"`)
    .replace(/<svg([^>]*?)>/, (_m, attrs) =>
      attrs.includes('xmlns=') ? `<svg${attrs}>` : `<svg xmlns="${SVG_NAMESPACE}"${attrs}>`
    );
  if (typeof Image === 'undefined' || typeof document === 'undefined') return null;
  const blob = new Blob([coloured], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, size, size);
    const pngBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/png')
    );
    if (!pngBlob) return null;
    const buf = await pngBlob.arrayBuffer();
    return Array.from(new Uint8Array(buf));
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
};

/// Rasterise the four YT-Music transport icons once at boot and hand the
/// bytes to Rust. The icons are static (play/pause/prev/next) so a single
/// push suffices — subsequent menu rebuilds reuse the cached bytes.
export const pushPlayerIcons = async (): Promise<void> => {
  const [prev, play, pause, next] = await Promise.all([
    rasteriseSvgNode(createElement(PrevIcon, { size: 18 })),
    rasteriseSvgNode(createElement(PlayIcon, { size: 18 })),
    rasteriseSvgNode(createElement(PauseIcon, { size: 18 })),
    rasteriseSvgNode(createElement(NextIcon, { size: 18 })),
  ]);
  try {
    await invoke('tray_set_player_icons', {
      icons: { prev, play, pause, next },
    });
  } catch (err) {
    console.warn('[tray] set_player_icons failed', err);
  }
};

/// Fetch the YT-Music thumbnail URL, re-encode to a square PNG suitable for
/// a macOS menu row, and hand the bytes to Rust. Passing `null` clears the
/// cached artwork so a stale cover doesn't linger after playback stops.
export const pushPlayerArtwork = async (url: string | null): Promise<void> => {
  if (!url) {
    try {
      await invoke('tray_set_player_artwork', { bytes: null });
    } catch (err) {
      console.warn('[tray] clear_player_artwork failed', err);
    }
    return;
  }
  if (typeof Image === 'undefined' || typeof document === 'undefined') return;
  const bytes = await (async (): Promise<number[] | null> => {
    try {
      // `img.decode()` handles cross-origin for typical YT-Music thumbnail
      // hosts (lh3.googleusercontent.com); if a provider forbids anonymous
      // reads we'll hit a tainted-canvas error below and bail out silently.
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = url;
      await img.decode();
      const size = 36;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, size, size);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), 'image/png')
      );
      if (!blob) return null;
      const buf = await blob.arrayBuffer();
      return Array.from(new Uint8Array(buf));
    } catch {
      return null;
    }
  })();
  try {
    await invoke('tray_set_player_artwork', { bytes });
  } catch (err) {
    console.warn('[tray] set_player_artwork failed', err);
  }
};

/// Rebuild the native tray context menu to match the current module set.
/// Call whenever the list of visible modules (or their order) changes.
export const pushTrayMenu = async (mods: TrayModuleInput[]): Promise<void> => {
  const icons: Record<string, number[] | null> = {};
  await Promise.all(
    mods.map(async (m) => {
      icons[m.id] = await renderTrayIcon(m.id);
    })
  );
  const items = buildTrayMenuItems(mods, icons);
  try {
    await invoke('tray_set_menu', { items });
  } catch (err) {
    // Tray is a nice-to-have surface — never let a failure here cascade
    // into the popup boot path.
    console.warn('[tray] set_menu failed', err);
  }
};
