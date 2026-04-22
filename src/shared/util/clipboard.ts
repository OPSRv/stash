/// Unified copy-to-clipboard helper. Tries the Tauri plugin first because it
/// works even when the webview lacks focus (toolbar buttons are a common
/// offender on macOS), then falls back to `navigator.clipboard` inside a
/// browser-only context (tests, storybook, e2e).
///
/// Returns `true` on success so call sites can branch on the result — the
/// AI chat bubble wants to show a "Copied" tick, the translator toast wants
/// to report failure to the user, etc. Swallows the underlying error but
/// logs it to the console so silent copy failures remain debuggable.

import { writeText } from '@tauri-apps/plugin-clipboard-manager';

export const copyText = async (text: string): Promise<boolean> => {
  try {
    await writeText(text);
    return true;
  } catch (e) {
    // Fallback only matters outside the Tauri runtime (tests, dev in a
    // plain browser). Keep it cheap — a single catch-chain.
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (fallbackError) {
      console.error('copyText failed', e, fallbackError);
      return false;
    }
  }
};
