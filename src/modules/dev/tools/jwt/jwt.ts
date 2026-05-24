/// JWT parsing helpers — pure, no React. Kept separate so the shell
/// can use `looksLikeJwt` from the clipboard hook without dragging in
/// the tool view's chunk.

/// Three base64url segments separated by `.`. The signature segment
/// may be empty for unsigned tokens (`alg: none`), so we keep the
/// `*` quantifier on the third group. We deliberately don't match
/// surrounding text — callers should `.trim()` first; that keeps
/// pasted-with-quotes nonsense out of the auto-open path.
export const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/// Strip a leading `Bearer ` / `Token ` prefix (case-insensitive) so a
/// copy-paste from "Authorization: Bearer eyJ…" still parses. We don't
/// touch trailing junk — the regex below already anchors on the
/// 3-segment shape.
export const stripBearer = (text: string): string =>
  text.trim().replace(/^(?:Bearer|Token)\s+/i, '').trim();

export const looksLikeJwt = (text: string): boolean => {
  const t = stripBearer(text);
  // Headers + payloads tend to be at least ~10 chars decoded; reject
  // trivially short matches that would just be noise in the auto-open
  // path (e.g. `a.b.c`).
  if (t.length < 20) return false;
  if (!JWT_RE.test(t)) return false;
  // Confirm by decoding header + payload as JSON. Cheap to do and
  // eliminates false positives from random `x.y.z` patterns that
  // happen to be base64url-safe.
  const parts = t.split('.');
  try {
    const header = JSON.parse(b64urlDecode(parts[0]));
    JSON.parse(b64urlDecode(parts[1]));
    return typeof header === 'object' && header !== null;
  } catch {
    return false;
  }
};

/// Decode a base64url-encoded string into UTF-8. Throws on malformed
/// input — caller decides whether to surface or swallow.
export const b64urlDecode = (input: string): string => {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const binary = atob(b64);
  // Re-decode as UTF-8 so multi-byte chars in claims (e.g. Cyrillic
  // `name`) survive intact.
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
};

export interface DecodedJwt {
  header: unknown;
  payload: unknown;
  signature: string;
  raw: {
    header: string;
    payload: string;
    signature: string;
  };
}

export type DecodeResult =
  | { ok: true; decoded: DecodedJwt }
  | { ok: false; error: string };

export const decodeJwt = (token: string): DecodeResult => {
  const trimmed = stripBearer(token);
  if (!trimmed) return { ok: false, error: 'Paste a JWT to decode it.' };
  const parts = trimmed.split('.');
  if (parts.length !== 3) {
    return {
      ok: false,
      error: `JWT must have 3 segments separated by ".", got ${parts.length}.`,
    };
  }
  let headerJson: string;
  let payloadJson: string;
  try {
    headerJson = b64urlDecode(parts[0]);
  } catch {
    return { ok: false, error: 'Header segment is not valid base64url.' };
  }
  try {
    payloadJson = b64urlDecode(parts[1]);
  } catch {
    return { ok: false, error: 'Payload segment is not valid base64url.' };
  }
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(headerJson);
  } catch {
    return { ok: false, error: 'Header is not valid JSON.' };
  }
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { ok: false, error: 'Payload is not valid JSON.' };
  }
  return {
    ok: true,
    decoded: {
      header,
      payload,
      signature: parts[2],
      raw: { header: headerJson, payload: payloadJson, signature: parts[2] },
    },
  };
};

/// Claims whose value is a Unix timestamp. Used by the tree view to
/// annotate the value with a human-readable date next to the raw
/// number. `nbf`/`iat`/`exp` are the standard RFC 7519 ones; `auth_time`
/// is common in OIDC tokens.
export const TIMESTAMP_CLAIMS = new Set([
  'iat',
  'exp',
  'nbf',
  'auth_time',
  'updated_at',
]);

export const formatTimestamp = (n: number): string | null => {
  if (!Number.isFinite(n) || n <= 0) return null;
  // Tokens almost always use seconds; if the value looks like
  // milliseconds (post-2001 ms timestamps are 13 digits), treat it
  // as such so we don't render year-50000 dates.
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
};
