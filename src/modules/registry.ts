import type { ModuleDefinition } from './types';
import { aiModule } from './ai';
import { clipboardModule } from './clipboard';
import { downloaderModule } from './downloader';
import { metronomeModule } from './metronome';
import { musicModule } from './music';
import { notesModule } from './notes';
import { pomodoroModule } from './pomodoro';
import { separatorModule } from './separator';
import { systemModule } from './system';
import { telegramModule } from './telegram';
import { terminalModule } from './terminal';
import { translatorModule } from './translator';
import { webModule } from './web';
import { settingsModule } from '../settings';

export const modules: ModuleDefinition[] = [
  clipboardModule,
  downloaderModule,
  notesModule,
  translatorModule,
  aiModule,
  webModule,
  telegramModule,
  musicModule,
  separatorModule,
  metronomeModule,
  pomodoroModule,
  terminalModule,
  systemModule,
  settingsModule,
];

export const modulesById: Record<string, ModuleDefinition> = Object.fromEntries(
  modules.map((m) => [m.id, m])
);
