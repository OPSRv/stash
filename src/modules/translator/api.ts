import { invoke } from '@tauri-apps/api/core';

export type Translation = {
  original: string;
  translated: string;
  from: string;
  to: string;
};

export const translate = (
  text: string,
  to: string,
  from?: string
): Promise<Translation> => invoke('translator_run', { text, to, from });

export const setTranslatorSettings = (args: {
  enabled: boolean;
  target: string;
  minChars?: number;
}): Promise<void> => invoke('translator_set_settings', args);

export type TranslationRow = {
  id: number;
  original: string;
  translated: string;
  from_lang: string;
  to_lang: string;
  created_at: number;
};

export const translatorList = (limit?: number): Promise<TranslationRow[]> =>
  invoke('translator_list', { limit });

export const translatorSearch = (query: string): Promise<TranslationRow[]> =>
  invoke('translator_search', { query });

export const translatorDelete = (id: number): Promise<void> =>
  invoke('translator_delete', { id });

export const translatorClear = (): Promise<number> => invoke('translator_clear');
