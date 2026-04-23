/// xterm colour scheme derived from the current `.light` class on
/// `<html>` — keeps the terminal matching Stash's light/dark theme
/// without maintaining a parallel palette in xterm config.

const readAccentRgb = (): string => {
  if (typeof document === 'undefined') return '47,122,229';
  const styles = getComputedStyle(document.documentElement);
  const rgb = styles.getPropertyValue('--stash-accent-rgb').trim();
  return rgb || '47,122,229';
};

const readAccent = (): string => `rgb(${readAccentRgb()})`;

export const xtermThemeFor = (isLight: boolean) => ({
  background: 'rgba(0,0,0,0)',
  foreground: isLight ? '#1a1c21' : '#e7e7ea',
  cursor: readAccent(),
  cursorAccent: isLight ? '#ffffff' : '#1a1c21',
  // Selection uses the app's accent so it matches the rest of the
  // chrome (tab underline, splitter hover, caret). Alpha is kept low —
  // xterm highlights entire empty columns when the user sweeps past
  // line-ends, so a heavy fill turns into a distracting wall of colour
  // over empty buffer rows.
  selectionBackground: isLight
    ? `rgba(${readAccentRgb()}, 0.18)`
    : `rgba(${readAccentRgb()}, 0.22)`,
  selectionInactiveBackground: isLight
    ? `rgba(${readAccentRgb()}, 0.10)`
    : `rgba(${readAccentRgb()}, 0.12)`,
  selectionForeground: undefined,
  black: isLight ? '#1a1c21' : '#1a1a1f',
  brightBlack: '#555',
  red: '#e0585b',
  brightRed: '#f87171',
  green: '#35b26a',
  brightGreen: '#43d66b',
  yellow: '#d29922',
  brightYellow: '#fbbf24',
  blue: isLight ? '#2f7ae5' : '#4a8bea',
  brightBlue: '#6aa3ff',
  magenta: '#b36bdf',
  brightMagenta: '#c89aff',
  cyan: '#2aa5a0',
  brightCyan: '#5ad8d2',
  white: isLight ? '#3a3a40' : '#cfcfd4',
  brightWhite: isLight ? '#000' : '#ffffff',
});

/// Decode base64 → raw bytes for xterm's `write`. Multibyte UTF-8 and
/// ANSI control bytes must survive the IPC boundary intact.
export const decodeBase64 = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export const encodeBase64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};

/// Fire a native desktop notification when a BEL byte arrives from the
/// PTY. Permission is requested lazily on first use and cached — no
/// toast inside the app since the whole point is being informed while
/// the popup is hidden.
let notifyPermission: 'granted' | 'denied' | 'unknown' = 'unknown';
export const notifyCommandDone = async (): Promise<void> => {
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import(
      '@tauri-apps/plugin-notification'
    );
    if (notifyPermission === 'unknown') {
      const granted = await isPermissionGranted();
      notifyPermission = granted
        ? 'granted'
        : (await requestPermission()) === 'granted'
          ? 'granted'
          : 'denied';
    }
    if (notifyPermission !== 'granted') return;
    sendNotification({ title: 'Terminal', body: 'Command finished.' });
  } catch {
    /* swallow — notifications are best-effort */
  }
};
