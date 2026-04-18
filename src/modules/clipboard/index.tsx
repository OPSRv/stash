import type { ModuleDefinition } from '../types';
import { ClipboardPopup } from './ClipboardPopup';

export const clipboardModule: ModuleDefinition = {
  id: 'clipboard',
  title: 'Clipboard',
  shortcut: 'CmdOrCtrl+Shift+V',
  PopupView: ClipboardPopup,
};
