export type TargetLanguage = {
  code: string;
  label: string;
};

/// Curated shortlist — the full ISO-639 set isn't useful in a dropdown. Extend
/// as users ask for more languages; Google endpoint accepts any ISO-639-1.
export const TARGET_LANGUAGES: TargetLanguage[] = [
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
