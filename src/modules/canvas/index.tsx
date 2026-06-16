import { lazy } from 'react';
import type { ModuleDefinition } from '../types';

// Lazy view + the SAME import thunk for preload, so the heavy Konva editor
// chunk stays off-heap until the Canvas tab is first opened / hovered.
const load = () => import('./CanvasShell').then((m) => ({ default: m.CanvasShell }));

export const canvasModule: ModuleDefinition = {
  id: 'canvas',
  title: 'Canvas',
  PopupView: lazy(load),
  preloadPopup: load,
  tabShortcutDigit: 7,
};
