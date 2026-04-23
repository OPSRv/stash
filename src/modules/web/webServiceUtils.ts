import type { WebChatService } from '../../settings/store';

/// Derive a safe id from a human label. Rust-side `label_for()` rejects
/// anything outside `[a-zA-Z0-9_-]+`, so this keeps us in sync.
export const slugify = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'service';

/// Ensure the derived id doesn't collide with an existing service. If it does,
/// append `-2`, `-3`, … until it's free. Keeps `slugify` pure.
export const uniqueServiceId = (
  base: string,
  existing: readonly WebChatService[],
): string => {
  const used = new Set(existing.map((s) => s.id));
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
};

/// Heuristic default label from a URL. Takes the most specific subdomain
/// part, e.g. "chat.openai.com" → "chat", "gemini.google.com" → "gemini",
/// "www.example.com" → "example". Falls back to the raw hostname when that
/// doesn't give anything useful.
export const defaultLabelFromUrl = (url: string): string => {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return '';
  }
  if (!host) return '';
  const parts = host.split('.').filter(Boolean);
  if (parts.length === 0) return host;
  // Drop a leading "www" so "www.example.com" becomes "example".
  const head = parts[0] === 'www' && parts.length > 1 ? parts[1] : parts[0];
  if (!head) return host;
  return head.charAt(0).toUpperCase() + head.slice(1);
};

/// Allowed zoom band — below 0.5 the chat UIs collapse into unreadable
/// glyphs, above 2.0 they blow past the popup's fixed 920×520 frame.
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2.0;
export const ZOOM_STEP = 0.1;

/// Clamp + round to 2 decimals so persisted values stay stable
/// (repeated `⌘+`/`⌘-` accumulates tiny float drift otherwise).
export const clampZoom = (value: number): number => {
  if (!Number.isFinite(value)) return 1;
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
  return Math.round(clamped * 100) / 100;
};

/// Pure move-one-item helper used by the tab drag-reorder UI. Returns the
/// same list instance when the operation would be a no-op so React can skip
/// an unnecessary re-render. `side` controls whether the source lands in
/// front of or after the target — the sidebar + Home tiles pick it from
/// the pointer's position relative to the target's midline.
export const reorderServices = <T extends { id: string }>(
  list: readonly T[],
  fromId: string,
  toId: string,
  side: 'before' | 'after' = 'before',
): T[] => {
  if (fromId === toId) return list as T[];
  const from = list.findIndex((s) => s.id === fromId);
  const to = list.findIndex((s) => s.id === toId);
  if (from === -1 || to === -1) return list as T[];
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  // After removal, the target's index shifts by one if we took an item
  // from before it. Re-resolve on the mutated list so both 'before' and
  // 'after' land on the correct slot.
  const newTargetIdx = next.findIndex((s) => s.id === toId);
  const insertAt = newTargetIdx + (side === 'after' ? 1 : 0);
  next.splice(insertAt, 0, moved);
  // When the move is a no-op (e.g. dropping just after its previous
  // neighbour) return the original list so React skips a render.
  const changed = next.some((s, i) => s.id !== list[i]?.id);
  return changed ? next : (list as T[]);
};

/// Minimal URL validator: must parse AND use http/https. Anything else
/// (file://, data:, about:) would fail in the Rust-side webview embed.
export const isEmbeddableUrl = (raw: string): boolean => {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};
