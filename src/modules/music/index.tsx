import type { ModuleDefinition } from '../types';
import { MusicShell } from './MusicShell';

export const musicModule: ModuleDefinition = {
  id: 'music',
  title: 'Music',
  PopupView: MusicShell,
};
