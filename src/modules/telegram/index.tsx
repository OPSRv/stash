import { lazy } from 'react';
import type { ModuleDefinition } from '../types';

const load = () =>
  import('./TelegramShell').then((m) => ({ default: m.TelegramShell }));

export const telegramModule: ModuleDefinition = {
  id: 'telegram',
  title: 'Telegram',
  PopupView: lazy(load),
  preloadPopup: load,
};
