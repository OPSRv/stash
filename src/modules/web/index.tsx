import { lazy } from 'react';

import type { ModuleDefinition } from '../types';

const load = () =>
  import('./WebShell').then((m) => ({ default: m.WebShell }));

export const webModule: ModuleDefinition = {
  id: 'web',
  title: 'Web',
  tabShortcutDigit: 9,
  PopupView: lazy(load),
  preloadPopup: load,
};
