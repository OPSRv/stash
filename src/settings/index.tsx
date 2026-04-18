import type { ModuleDefinition } from '../modules/types';
import { SettingsShell } from './SettingsShell';

export const settingsModule: ModuleDefinition = {
  id: 'settings',
  title: 'Settings',
  PopupView: SettingsShell,
};
