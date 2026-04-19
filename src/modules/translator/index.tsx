import { lazy } from 'react';
import type { ModuleDefinition } from '../types';

const load = () =>
  import('./TranslatorShell').then((m) => ({ default: m.TranslatorShell }));

export const translatorModule: ModuleDefinition = {
  id: 'translator',
  title: 'Translator',
  tabShortcutDigit: 5,
  PopupView: lazy(load),
  preloadPopup: load,
};
