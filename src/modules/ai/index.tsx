import { lazy } from 'react';

import type { ModuleDefinition } from '../types';

const load = () =>
  import('./AiShell').then((m) => ({ default: m.AiShell }));

export const aiModule: ModuleDefinition = {
  id: 'ai',
  title: 'AI',
  tabShortcutDigit: 9,
  PopupView: lazy(load),
  preloadPopup: load,
};
