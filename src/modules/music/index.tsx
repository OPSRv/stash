import { lazy } from 'react';
import type { ModuleDefinition } from '../types';

const load = () =>
  import('./MusicShell').then((m) => ({ default: m.MusicShell }));

export const musicModule: ModuleDefinition = {
  id: 'music',
  title: 'Music',
  tabShortcutDigit: 6,
  PopupView: lazy(load),
  preloadPopup: load,
};
