import type { ModuleDefinition } from './types';

/// Settings is always present and always anchored to the end of the tab bar
/// — hiding it would lock the user out of the surface that controls
/// visibility, and dragging it around the row offers no benefit.
export const PROTECTED_MODULE_ID = 'settings';

export interface ModulePrefs {
  hiddenModules: readonly string[];
  moduleOrder: readonly string[];
}

/// Resolve the list of modules that should appear in the popup tab bar,
/// in the order to render them. Pure: no IO, no side effects — both the
/// shell and the tray builder consume the same output.
///
/// Rules:
///  - Settings is never hidden and always last.
///  - Modules listed in `moduleOrder` come first, in that order.
///  - Modules not listed in `moduleOrder` keep their `registry.ts` order
///    and follow after the user-ordered ones (so a freshly added module
///    appears in a predictable slot rather than jumping to the front).
///  - Modules in `hiddenModules` are filtered out entirely.
export const resolveVisibleModules = (
  modules: readonly ModuleDefinition[],
  prefs: ModulePrefs,
): ModuleDefinition[] => {
  const hidden = new Set(prefs.hiddenModules);
  hidden.delete(PROTECTED_MODULE_ID);

  const byId = new Map(modules.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const ordered: ModuleDefinition[] = [];

  for (const id of prefs.moduleOrder) {
    if (id === PROTECTED_MODULE_ID) continue;
    if (hidden.has(id)) continue;
    if (seen.has(id)) continue;
    const m = byId.get(id);
    if (!m) continue;
    ordered.push(m);
    seen.add(id);
  }
  for (const m of modules) {
    if (m.id === PROTECTED_MODULE_ID) continue;
    if (hidden.has(m.id)) continue;
    if (seen.has(m.id)) continue;
    ordered.push(m);
    seen.add(m.id);
  }

  const settings = byId.get(PROTECTED_MODULE_ID);
  if (settings) ordered.push(settings);
  return ordered;
};
