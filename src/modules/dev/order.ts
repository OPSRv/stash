import type { DevTool } from './types';

const STORAGE_KEY = 'stash.dev.tileOrder';

/// Read the persisted tile order. Same merge contract as the popup-tab
/// `resolveVisibleModules`: stored ids first, unstored ids keep their
/// `registry.ts` order at the tail. Robust to malformed JSON / stale
/// ids — anything we can't reconcile is dropped silently.
export const loadOrder = (tools: readonly DevTool[]): string[] => {
  let stored: string[] = [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        stored = parsed.filter((x): x is string => typeof x === 'string');
      }
    }
  } catch {
    // localStorage unavailable or JSON broken — fall through to defaults.
  }
  return mergeOrder(stored, tools);
};

export const saveOrder = (order: readonly string[]): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch {
    // Best-effort: a save failure shouldn't surface as a UI error.
  }
};

/// Pure merge: stored ids that still exist come first, in their stored
/// order; everything else keeps its `registry.ts` position at the tail.
/// Exposed for unit tests + the Storybook fixture.
export const mergeOrder = (
  stored: readonly string[],
  tools: readonly DevTool[],
): string[] => {
  const known = new Map(tools.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of stored) {
    if (!known.has(id)) continue;
    if (seen.has(id)) continue;
    out.push(id);
    seen.add(id);
  }
  for (const t of tools) {
    if (seen.has(t.id)) continue;
    out.push(t.id);
    seen.add(t.id);
  }
  return out;
};

/// Move `fromId` next to `toId` on the given side. No-op when the
/// move would leave the order unchanged — keeps consumers free of
/// equality-check boilerplate before persisting.
export const moveTile = (
  order: readonly string[],
  fromId: string,
  toId: string,
  side: 'before' | 'after',
): string[] => {
  if (fromId === toId) return order.slice();
  const fromIdx = order.indexOf(fromId);
  const toIdx = order.indexOf(toId);
  if (fromIdx < 0 || toIdx < 0) return order.slice();
  const next = order.slice();
  next.splice(fromIdx, 1);
  let targetIdx = next.indexOf(toId);
  if (targetIdx < 0) return order.slice();
  if (side === 'after') targetIdx += 1;
  next.splice(targetIdx, 0, fromId);
  return next;
};