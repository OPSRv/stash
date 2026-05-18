import { lazy } from 'react';
import type { ModuleDefinition } from '../types';

const load = () =>
  import('./DevShell').then((m) => ({ default: m.DevShell }));

export const devModule: ModuleDefinition = {
  id: 'dev',
  title: 'Dev',
  PopupView: lazy(load),
  preloadPopup: load,
};
