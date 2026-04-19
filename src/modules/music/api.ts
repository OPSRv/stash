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
export const musicPlayPause = (): Promise<void> => invoke('music_play_pause');
export const musicNext = (): Promise<void> => invoke('music_next');
export const musicPrev = (): Promise<void> => invoke('music_prev');

export type NowPlaying = {
  playing: boolean;
  title: string;
  artist: string;
  artwork: string;
};
