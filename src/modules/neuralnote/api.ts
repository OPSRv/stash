import { invoke } from '@tauri-apps/api/core';

export type NeuralNoteStatus = {
  installed: boolean;
  app_path: string | null;
  version: string | null;
};

export const neuralNoteStatus = (): Promise<NeuralNoteStatus> =>
  invoke('neuralnote_status');

/// Kick off the system Installer.app — resolves once `open` returns,
/// NOT once the user clicks Install. Poll status afterwards.
export const neuralNoteInstall = (): Promise<string> => invoke('neuralnote_install');

export const neuralNoteOpen = (): Promise<void> => invoke('neuralnote_open');
