import { invoke } from '@tauri-apps/api/core';

/** Run `fn` (typically a native open/save dialog) with popup auto-hide off,
 *  so the dialog's focus steal doesn't hide the popup and cancel it — see
 *  CLAUDE.md "Popup auto-hide". Restores auto-hide even when `fn` throws. */
export const withPopupPinned = async <T>(fn: () => Promise<T>): Promise<T> => {
  await invoke('set_popup_auto_hide', { enabled: false }).catch(() => {});
  try {
    return await fn();
  } finally {
    await invoke('set_popup_auto_hide', { enabled: true }).catch(() => {});
  }
};
