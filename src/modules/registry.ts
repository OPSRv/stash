import type { ModuleDefinition } from './types';
import { aiModule } from './ai';
import { clipboardModule } from './clipboard';
import { downloaderModule } from './downloader';
import { metronomeModule } from './metronome';
import { musicModule } from './music';
import { notesModule } from './notes';
import { pomodoroModule } from './pomodoro';
import { terminalModule } from './terminal';
import { translatorModule } from './translator';
import { settingsModule } from '../settings';

export const modules: ModuleDefinition[] = [
  clipboardModule,
  downloaderModule,
  notesModule,
  translatorModule,
  aiModule,
  musicModule,
  metronomeModule,
  pomodoroModule,
  terminalModule,
  settingsModule,
];

export const modulesById: Record<string, ModuleDefinition> = Object.fromEntries(
  modules.map((m) => [m.id, m])
);
