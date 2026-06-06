import { lazy } from 'react';
import type { ModuleDefinition } from '../types';

const load = () =>
  import('./ValetonShell').then((m) => ({ default: m.ValetonShell }));

export const valetonEditorModule: ModuleDefinition = {
  id: 'valeton-editor',
  title: 'Valeton GP-5',
  PopupView: lazy(load),
  preloadPopup: load,
};
