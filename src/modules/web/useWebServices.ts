import { useEffect, useState } from 'react';

import { DEFAULT_SETTINGS, loadSettings, type WebChatService } from '../../settings/store';

/// Reactive accessor for the web-tab service list. Mirrors `useAiSettings`'s
/// pattern — re-reads on mount and on `stash:settings-changed`. The list is
/// stored under `aiWebServices` in settings for backward compatibility with
/// existing user data even though the feature now lives in the Web module.
export const useWebServices = (): WebChatService[] => {
  const [value, setValue] = useState<WebChatService[]>(DEFAULT_SETTINGS.aiWebServices);

  useEffect(() => {
    let cancelled = false;
    const read = () => {
      loadSettings()
        .then((s) => {
          if (!cancelled) setValue(s.aiWebServices);
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
