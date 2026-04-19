import type { ModuleDefinition } from '../types';
import { RecorderShell } from './RecorderShell';

export const recorderModule: ModuleDefinition = {
  id: 'recorder',
  title: 'Recorder',
  PopupView: RecorderShell,
};
