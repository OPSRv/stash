import type { ModuleDefinition } from './types';
import { clipboardModule } from './clipboard';
import { downloaderModule } from './downloader';
import { musicModule } from './music';
import { notesModule } from './notes';
import { recorderModule } from './recorder';
import { translatorModule } from './translator';
import { settingsModule } from '../settings';

export const modules: ModuleDefinition[] = [
  clipboardModule,
  downloaderModule,
  recorderModule,
  notesModule,
  translatorModule,
  musicModule,
  settingsModule,
];

export const modulesById: Record<string, ModuleDefinition> = Object.fromEntries(
  modules.map((m) => [m.id, m])
);
