import { lazy } from 'react';
import type { ModuleDefinition } from '../types';

const load = () =>
  import('./DownloadsShell').then((m) => ({ default: m.DownloadsShell }));

export const downloaderModule: ModuleDefinition = {
  id: 'downloads',
  title: 'Downloads',
  tabShortcutDigit: 2,
  PopupView: lazy(load),
  preloadPopup: load,
};
