import { lazy } from 'react';
import type { ModuleDefinition } from '../types';

const load = () =>
  import('./PomodoroShell').then((m) => ({ default: m.PomodoroShell }));

export const pomodoroModule: ModuleDefinition = {
  id: 'pomodoro',
  title: 'Pomodoro',
  tabShortcutDigit: 3,
  PopupView: lazy(load),
  preloadPopup: load,
};
