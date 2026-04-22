/// Top-level classification used for filter tabs and row layout.
/// Stable and short — new text-flavour subcategories go through
/// `TextSubtype` so the filter footer stays ⌘1-⌘5.
export type ContentType = 'link' | 'code' | 'image' | 'text' | 'file';

/// Fine-grained classification inside a `text` row. Drives the left
/// icon, the tint, and a subtype-specific action button (mailto for
/// email, tel for phone, "Pretty JSON" preview for json, reveal-
/// masked-value for secrets). Purely a display concern — nothing
/// about this is persisted in SQLite.
export type TextSubtype =
  | 'plain'
  | 'email'
  | 'phone'
  | 'hex-color'
  | 'uuid'
  | 'json'
  | 'file-path'
  | 'secret';

const CODE_HINTS = /[{};]|=>|\bconst\b|\bfunction\b|\bimport\b|\bdef\b|\breturn\b/;

/// Light normaliser: trim whitespace + strip C0/C1 / BOM control chars.
/// Subtype detectors use this variant because they care about literal
/// content -- stripping a trailing `]` would break `[1,2,3]` JSON
/// detection, and stripping a trailing `)` would break `rgba(...)`.
const normalizeLite = (raw: string) =>
  raw
    // strip C0/C1 control chars (including NUL, BOM-adjacent, etc.)
    .replace(/[\u0000-\u001F\u007F-\u009F\uFEFF]/g, '')
    .trim();

/// Aggressive normaliser for URL detection: strips surrounding
/// quotes / angle brackets / parens / square brackets on top of
/// `normalizeLite`.
const normalize = (raw: string) =>
  normalizeLite(raw)
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

// ---- subtype detectors -----------------------------------------------------
//
// Ordering matters: secrets win over everything else so a GitHub PAT
// that happens to look like JSON doesn't get rendered as plain JSON.
// Every detector works on `normalize(raw)` — identical to the rules
// detectType uses — so a quoted or angle-bracketed value still hits.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?\d[\d\s().-]{6,}$/;
const HEX_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_FN_RE = /^rgba?\s*\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+))?\s*\)$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_PATH_RE = /^(\/Users\/|\/home\/|\/var\/|\/tmp\/|\/opt\/|~\/)/;

/// Regex catalog for secrets. Kept in one place because adding a new
/// provider is the most common change — just append `/pattern/`. The
/// detector returns on the first hit, so costly regexes go last.
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,          // PEM
  /\bsk-[A-Za-z0-9_-]{20,}\b/,                   // OpenAI-ish
  /\bsk-ant-[A-Za-z0-9_-]{30,}\b/,               // Anthropic
  /\bghp_[A-Za-z0-9]{30,}\b/,                    // GitHub classic PAT
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/,            // GitHub fine-grained PAT
  /\bgho_[A-Za-z0-9]{30,}\b/,                    // GitHub OAuth user-to-server
  /\bghs_[A-Za-z0-9]{30,}\b/,                    // GitHub server-to-server
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,            // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/,                        // AWS access key ID
  /\bASIA[0-9A-Z]{16}\b/,                        // AWS temporary creds
  /\bAIza[0-9A-Za-z_-]{35}\b/,                   // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
];

const looksLikeJson = (s: string): boolean => {
  if (s.length < 2) return false;
  const first = s[0];
  const last = s[s.length - 1];
  if (!((first === '{' && last === '}') || (first === '[' && last === ']'))) {
    return false;
  }
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};

/// Classify a text clip's subtype for display. For non-text clipboard
/// kinds (image, file) callers shouldn't need this — they already have
/// richer metadata.
export const detectTextSubtype = (raw: string): TextSubtype => {
  const s = normalizeLite(raw);
  if (!s) return 'plain';
  if (SECRET_PATTERNS.some((re) => re.test(s))) return 'secret';
  if (EMAIL_RE.test(s)) return 'email';
  if (PHONE_RE.test(s) && /\d/.test(s) && s.replace(/\D/g, '').length >= 7) {
    return 'phone';
  }
  if (HEX_COLOR_RE.test(s) || RGB_FN_RE.test(s)) return 'hex-color';
  if (UUID_RE.test(s)) return 'uuid';
  if (FILE_PATH_RE.test(s)) return 'file-path';
  if (looksLikeJson(s)) return 'json';
  return 'plain';
};

/// Best-effort pretty-print for JSON clips. Returns `null` when the
/// input isn't parseable — callers fall back to raw text. Used by the
/// Space-key preview so a pasted API response renders with indentation
/// instead of a flat blob.
export const prettyJson = (raw: string): string | null => {
  const s = normalizeLite(raw);
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return null;
  }
};

/// Mask a secret for display. Keeps the first 4 and last 4 characters
/// so the user can recognise which credential this is without exposing
/// the middle. Non-secret values are returned unchanged.
export const maskSecret = (raw: string): string => {
  const s = raw.trim();
  if (s.length <= 10) return '•'.repeat(Math.max(4, s.length));
  return `${s.slice(0, 4)}${'•'.repeat(Math.max(6, s.length - 8))}${s.slice(-4)}`;
};
