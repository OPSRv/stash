import type { ModuleDefinition } from './types';
import { aiModule } from './ai';
import { clipboardModule } from './clipboard';
import { converterModule } from './converter';
import { devModule } from './dev';
import { downloaderModule } from './downloader';
import { metronomeModule } from './metronome';
import { musicModule } from './music';
import { notesModule } from './notes';
import { pomodoroModule } from './pomodoro';
import { remindersModule } from './reminders';
import { separatorModule } from './separator';
import { systemModule } from './system';
import { telegramModule } from './telegram';
import { terminalModule } from './terminal';
import { translatorModule } from './translator';
import { valetonEditorModule } from './valeton-editor';
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
  converterModule,
  metronomeModule,
  valetonEditorModule,
  pomodoroModule,
  remindersModule,
  terminalModule,
  devModule,
  systemModule,
  settingsModule,
];

export const modulesById: Record<string, ModuleDefinition> = Object.fromEntries(
  modules.map((m) => [m.id, m])
);
