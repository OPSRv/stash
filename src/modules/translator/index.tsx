import type { ModuleDefinition } from '../types';
import { TranslatorShell } from './TranslatorShell';

export const translatorModule: ModuleDefinition = {
  id: 'translator',
  title: 'Translator',
  PopupView: TranslatorShell,
};
