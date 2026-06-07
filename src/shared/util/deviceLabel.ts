/** Shorten a verbose audio-device label for compact UI. Strips the
 *  "Default - " prefix that Chrome/macOS prepend, a trailing parenthetical
 *  qualifier (e.g. "(Built-in)"), and a redundant trailing "Microphone" word,
 *  so "MacBook Pro Microphone" reads as "MacBook Pro". Falls back to the
 *  original label if trimming would empty it. */
export const shortDeviceLabel = (label: string): string => {
  const original = label.trim();
  let s = original.replace(/^default\s*[-–—]\s*/i, '');
  s = s.replace(/\s*\([^)]*\)\s*$/, '');
  const stripped = s.replace(/\s+microphones?$/i, '').trim();
  if (stripped) s = stripped;
  return s.trim() || original;
};
