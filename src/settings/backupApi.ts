import { invoke } from '@tauri-apps/api/core';

export interface ModuleDescription {
  id: string;
  label: string;
  summary: string;
  size_bytes: number;
  available: boolean;
}

export interface ExportOptions {
  modules: string[];
  include_media: boolean;
  include_settings: boolean;
}

export interface ExportReport {
  path: string;
  size_bytes: number;
  modules: string[];
}

export interface ModuleEntry {
  label: string;
  db?: string | null;
  json?: string | null;
  media_prefix?: string | null;
  size_bytes: number;
}

export interface Manifest {
  app_version: string;
  backup_format_version: number;
  created_at: string;
  include_media: boolean;
  include_settings: boolean;
  modules: Record<string, ModuleEntry>;
}

export interface InspectReport {
  manifest: Manifest;
  unknown_modules: string[];
  missing_modules: string[];
}

export interface ImportSelection {
  modules: string[];
  include_media: boolean;
  include_settings: boolean;
}

export const describeBackup = () =>
  invoke<ModuleDescription[]>('backup_describe');

export const suggestFilename = () => invoke<string>('backup_suggest_filename');

export const exportBackup = (out_path: string, options: ExportOptions) =>
  invoke<ExportReport>('backup_export', { outPath: out_path, options });

export const inspectBackup = (path: string) =>
  invoke<InspectReport>('backup_inspect', { path });

export const importBackup = (path: string, selection: ImportSelection) =>
  invoke<void>('backup_import', { path, selection });

export const readImportError = () =>
  invoke<string | null>('backup_last_error');

export const dismissImportError = () =>
  invoke<void>('backup_dismiss_error');
