import { useEffect, useState } from 'react';

import { DEFAULT_SETTINGS, loadSettings, type Settings } from '../../settings/store';

export type AiSettings = Pick<
  Settings,
  | 'aiProvider'
  | 'aiModel'
  | 'aiBaseUrl'
  | 'aiSystemPrompt'
  | 'aiApiKeys'
  | 'aiWebServices'
>;

const pick = (s: Settings): AiSettings => ({
  aiProvider: s.aiProvider,
  aiModel: s.aiModel,
  aiBaseUrl: s.aiBaseUrl,
  aiSystemPrompt: s.aiSystemPrompt,
  aiApiKeys: s.aiApiKeys,
  aiWebServices: s.aiWebServices,
});

const defaults: AiSettings = pick(DEFAULT_SETTINGS);

/// Reactive accessor for AI-related settings. Re-reads on mount and on the
/// `stash:settings-changed` window event (emitted by SettingsShell after each
/// save). Shared by the AI tab and any other module that gates UI on whether
/// AI is enabled (e.g. future Notes "summarise with AI" button).
export const useAiSettings = (): AiSettings => {
  const [value, setValue] = useState<AiSettings>(defaults);

  useEffect(() => {
    let cancelled = false;
    const read = () => {
      loadSettings()
        .then((s) => {
          if (!cancelled) setValue(pick(s));
        })
        .catch(() => {});
    };
    read();
    window.addEventListener('stash:settings-changed', read);
    return () => {
      cancelled = true;
      window.removeEventListener('stash:settings-changed', read);
    };
  }, []);

  return value;
};
