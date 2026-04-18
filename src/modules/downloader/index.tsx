import type { ModuleDefinition } from '../types';
import { DownloadsShell } from './DownloadsShell';

export const downloaderModule: ModuleDefinition = {
  id: 'downloads',
  title: 'Downloads',
  PopupView: DownloadsShell,
};
