export type TargetLanguage = {
  code: string;
  label: string;
};

/// Look up the human-readable label for a language code. Falls back to the
/// code itself (uppercased) so unknown languages still render something
/// meaningful — important because `from_lang` can return anything Google
/// decides to detect.
export const languageLabel = (code: string | null | undefined): string => {
  if (!code) return '';
  if (code === 'auto') return 'Auto-detected';
  const match = TARGET_LANGUAGES.find((l) => l.code === code);
  return match?.label ?? code.toUpperCase();
};

/// Languages whose scripts render right-to-left. Used to flip textarea
/// direction so Arabic/Hebrew results read correctly.
const RTL_CODES = new Set(['ar', 'he', 'fa', 'ur']);
export const isRtl = (code: string | null | undefined): boolean =>
  code != null && RTL_CODES.has(code);

/// Curated shortlist — the full ISO-639 set isn't useful in a dropdown. Extend
/// as users ask for more languages; Google endpoint accepts any ISO-639-1.
export const TARGET_LANGUAGES: TargetLanguage[] = [
  { code: 'en', label: 'English' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'pl', label: 'Polish' },
  { code: 'de', label: 'German' },
  { code: 'fr', label: 'French' },
  { code: 'es', label: 'Spanish' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'nl', label: 'Dutch' },
  { code: 'cs', label: 'Czech' },
  { code: 'tr', label: 'Turkish' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese (simplified)' },
];
