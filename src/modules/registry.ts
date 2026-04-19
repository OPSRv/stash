import type { ModuleDefinition } from './types';
import { clipboardModule } from './clipboard';
import { downloaderModule } from './downloader';
import { metronomeModule } from './metronome';
import { musicModule } from './music';
import { notesModule } from './notes';
import { recorderModule } from './recorder';
import { terminalModule } from './terminal';
import { translatorModule } from './translator';
import { settingsModule } from '../settings';

export const modules: ModuleDefinition[] = [
  clipboardModule,
  downloaderModule,
  recorderModule,
  notesModule,
  translatorModule,
  musicModule,
  metronomeModule,
  terminalModule,
  settingsModule,
];

export const modulesById: Record<string, ModuleDefinition> = Object.fromEntries(
  modules.map((m) => [m.id, m])
);
