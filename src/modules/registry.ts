import type { ModuleDefinition } from './types';
import { clipboardModule } from './clipboard';
import { downloaderModule } from './downloader';
import { settingsModule } from '../settings';

export const modules: ModuleDefinition[] = [clipboardModule, downloaderModule, settingsModule];

export const modulesById: Record<string, ModuleDefinition> = Object.fromEntries(
  modules.map((m) => [m.id, m])
);
