import type { ComponentType } from 'react';

export type ModuleId = string;

export interface ModuleDefinition {
  id: ModuleId;
  title: string;
  shortcut?: string;
  PopupView?: ComponentType;
  WindowView?: ComponentType;
  SettingsView?: ComponentType;
}
