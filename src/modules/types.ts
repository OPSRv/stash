import type { ComponentType, LazyExoticComponent } from 'react';

export type ModuleId = string;

export interface ModuleDefinition {
  id: ModuleId;
  title: string;
  shortcut?: string;
  /**
   * Preferred ⌘⌥N digit (1–9). Stable per module id, independent of the
   * order modules appear in `registry.ts`. Inserting a new module no longer
   * shifts every other user's muscle memory. When omitted, no ⌘⌥N binding
   * is registered for this module.
   */
  tabShortcutDigit?: number;
  PopupView?: ComponentType | LazyExoticComponent<ComponentType>;
  WindowView?: ComponentType | LazyExoticComponent<ComponentType>;
  SettingsView?: ComponentType | LazyExoticComponent<ComponentType>;
  /**
   * Warm up the PopupView chunk without rendering it. Called on tab hover
   * so the click feels instant. Safe to call repeatedly — dynamic `import()`
   * is memoised by the runtime.
   */
  preloadPopup?: () => Promise<unknown>;
}
