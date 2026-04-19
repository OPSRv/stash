import { lazy } from 'react';
import type { ModuleDefinition } from '../types';

const load = () =>
  import('./RecorderShell').then((m) => ({ default: m.RecorderShell }));

export const recorderModule: ModuleDefinition = {
  id: 'recorder',
  title: 'Recorder',
  tabShortcutDigit: 3,
  PopupView: lazy(load),
  preloadPopup: load,
};
