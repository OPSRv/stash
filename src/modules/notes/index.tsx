import type { ModuleDefinition } from '../types';
import { NotesShell } from './NotesShell';

export const notesModule: ModuleDefinition = {
  id: 'notes',
  title: 'Notes',
  PopupView: NotesShell,
};
