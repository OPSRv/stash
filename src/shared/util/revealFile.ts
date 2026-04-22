/// Thin wrapper around `@tauri-apps/plugin-opener`'s `revealItemInDir` that
/// swallows errors — the common UX pattern across every system panel is
/// "show in Finder, ignore failures". Keeping it in one place means we can
/// later add telemetry or a toast fallback without touching each call site.

import { revealItemInDir } from '@tauri-apps/plugin-opener';

export const revealFile = (path: string): Promise<void> =>
  revealItemInDir(path).catch(() => undefined);
