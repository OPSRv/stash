import { lazy } from 'react';
import type { ModuleDefinition } from '../types';

const load = () =>
  import('./ClipboardPopup').then((m) => ({ default: m.ClipboardPopup }));

export const clipboardModule: ModuleDefinition = {
  id: 'clipboard',
  title: 'Clipboard',
  shortcut: 'CmdOrCtrl+Shift+V',
  tabShortcutDigit: 1,
  PopupView: lazy(load),
  preloadPopup: load,
};
