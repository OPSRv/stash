import { lazy } from 'react';
import type { ModuleDefinition } from '../types';

const load = () =>
  import('./RemindersShell').then((m) => ({ default: m.RemindersShell }));

export const remindersModule: ModuleDefinition = {
  id: 'reminders',
  title: 'Reminders',
  PopupView: lazy(load),
  preloadPopup: load,
};
