export type ContentType = 'link' | 'code' | 'image' | 'text';

const CODE_HINTS = /[{};]|=>|\bconst\b|\bfunction\b|\bimport\b|\bdef\b|\breturn\b/;

const normalize = (raw: string) =>
  raw
    // strip C0/C1 control chars (including NUL, BOM-adjacent, etc.)
    .replace(/[\u0000-\u001F\u007F-\u009F\uFEFF]/g, '')
    .trim()
    // strip common wrapping punctuation so "<url>" and "\"url\"" still detect
    .replace(/^[<"'`[(]+/, '')
    .replace(/[>"'`\])]+$/, '');

const URL_RE = /^https?:\/\/\S+$/i;

export const detectType = (raw: string): ContentType => {
  const s = normalize(raw);
  if (!s) return 'text';
  if (URL_RE.test(s)) return 'link';
  if (CODE_HINTS.test(s)) return 'code';
  return 'text';
};
