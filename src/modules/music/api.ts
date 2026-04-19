import { invoke } from '@tauri-apps/api/core';

export type MusicStatus = {
  attached: boolean;
  visible: boolean;
};

export const musicStatus = (): Promise<MusicStatus> => invoke('music_status');

export const musicEmbed = (args: {
  x: number;
  y: number;
  width: number;
  height: number;
  userAgent?: string;
}): Promise<void> => invoke('music_embed', args);

export const musicShow = (): Promise<void> => invoke('music_show');
export const musicHide = (): Promise<void> => invoke('music_hide');
export const musicClose = (): Promise<void> => invoke('music_close');
export const musicReload = (): Promise<void> => invoke('music_reload');
