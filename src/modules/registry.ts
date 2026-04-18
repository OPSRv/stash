import type { ModuleDefinition } from './types';
import { clipboardModule } from './clipboard';

export const modules: ModuleDefinition[] = [clipboardModule];

export const modulesById: Record<string, ModuleDefinition> = Object.fromEntries(
  modules.map((m) => [m.id, m])
);
