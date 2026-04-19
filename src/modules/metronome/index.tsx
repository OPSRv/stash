import { lazy } from 'react';
import type { ModuleDefinition } from '../types';

const load = () =>
  import('./MetronomeShell').then((m) => ({ default: m.MetronomeShell }));

export const metronomeModule: ModuleDefinition = {
  id: 'metronome',
  title: 'Metronome',
  tabShortcutDigit: 7,
  PopupView: lazy(load),
  preloadPopup: load,
};
