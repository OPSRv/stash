export type ContentType = 'link' | 'code' | 'image' | 'text';

const URL_RE = /^https?:\/\/\S+$/i;
const CODE_HINTS = /[{};=()<>]|=>|\bconst\b|\bfunction\b|\bimport\b|\bdef\b|\breturn\b/;

export const detectType = (raw: string): ContentType => {
  const s = raw.trim();
  if (!s) return 'text';
  if (URL_RE.test(s)) return 'link';
  if (CODE_HINTS.test(s)) return 'code';
  return 'text';
};
