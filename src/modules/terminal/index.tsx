import { lazy } from 'react';
import type { ModuleDefinition } from '../types';

const load = () =>
  import('./TerminalShell').then((m) => ({ default: m.TerminalShell }));

export const terminalModule: ModuleDefinition = {
  id: 'terminal',
  title: 'Terminal',
  tabShortcutDigit: 8,
  PopupView: lazy(load),
  preloadPopup: load,
};
