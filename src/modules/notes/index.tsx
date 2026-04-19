import { lazy } from 'react';
import type { ModuleDefinition } from '../types';

const load = () =>
  import('./NotesShell').then((m) => ({ default: m.NotesShell }));

export const notesModule: ModuleDefinition = {
  id: 'notes',
  title: 'Notes',
  tabShortcutDigit: 4,
  PopupView: lazy(load),
  preloadPopup: load,
};
