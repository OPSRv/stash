import { lazy } from 'react';
import type { ModuleDefinition } from '../types';

const load = () =>
  import('./SeparatorShell').then((m) => ({ default: m.SeparatorShell }));

export const separatorModule: ModuleDefinition = {
  id: 'separator',
  title: 'Stems',
  PopupView: lazy(load),
  preloadPopup: load,
};
