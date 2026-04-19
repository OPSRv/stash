import { lazy } from 'react';
import type { ModuleDefinition } from '../modules/types';

const load = () =>
  import('./SettingsShell').then((m) => ({ default: m.SettingsShell }));

export const settingsModule: ModuleDefinition = {
  id: 'settings',
  title: 'Settings',
  PopupView: lazy(load),
  preloadPopup: load,
};
