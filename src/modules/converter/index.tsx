import { lazy } from 'react';
import type { ModuleDefinition } from '../types';

const load = () =>
  import('./ConverterShell').then((m) => ({ default: m.ConverterShell }));

export const converterModule: ModuleDefinition = {
  id: 'converter',
  title: 'Convert',
  PopupView: lazy(load),
  preloadPopup: load,
};
