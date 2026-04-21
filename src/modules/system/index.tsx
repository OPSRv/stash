import { lazy } from 'react';
import type { ModuleDefinition } from '../types';

const load = () =>
  import('./SystemShell').then((m) => ({ default: m.SystemShell }));

export const systemModule: ModuleDefinition = {
  id: 'system',
  title: 'System',
  PopupView: lazy(load),
  preloadPopup: load,
};
