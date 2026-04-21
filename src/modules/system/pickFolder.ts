import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

/// Wrap a native folder picker with the popup-auto-hide dance so the
/// window doesn't disappear the moment the modal steals focus.
export const pickFolder = async (): Promise<string | null> => {
  await invoke('set_popup_auto_hide', { enabled: false }).catch(() => undefined);
  try {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected === 'string') return selected;
    return null;
  } finally {
    await invoke('set_popup_auto_hide', { enabled: true }).catch(() => undefined);
  }
};
