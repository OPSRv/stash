import { LazyStore } from '@tauri-apps/plugin-store';
import { DEFAULT_THEME, type AccentKey, type ThemeMode } from './theme';

export type CookiesBrowser =
  | 'safari'
  | 'chrome'
  | 'firefox'
  | 'edge'
  | 'brave'
  | 'vivaldi'
  | 'chromium'
  | 'arc'
  | null;

export type Settings = {
  maxHistoryItems: number;
  launchAtLogin: boolean;
  downloadsFolder: string | null;
  notifyOnDownloadComplete: boolean;
  cookiesFromBrowser: CookiesBrowser;
  maxParallelDownloads: number;
  downloadRateLimit: string | null;
  historyRetentionDays: number;
  themeMode: ThemeMode;
  themeBlur: number;
  themePaneOpacity: number;
  themeAccent: AccentKey;
  translateEnabled: boolean;
  translateTarget: string;
  translateMinChars: number;
  translateShowNotification: boolean;
  aiProvider: AiProvider;
  aiModel: string;
  aiBaseUrl: string | null;
  aiSystemPrompt: string;
  /**
   * Per-provider API keys, stored alongside other settings in `settings.json`
   * under the app data dir. Not as locked-down as a proper keychain entry,
   * but reliable across `tauri dev` rebuilds (unsigned binaries lose macOS
   * Keychain ACL after each recompile, which breaks the Keychain approach
   * entirely in development).
   */
  aiApiKeys: Partial<Record<AiProvider, string>>;
  /**
   * Services embedded in the AI tab as native child webviews. Default set
   * covers Claude / ChatGPT / Gemini; users can add more from Settings →
   * AI. Each entry is {id, label, url}; id must be a slug that passes the
   * Rust-side label validator (`[a-zA-Z0-9_-]+`).
   */
  aiWebServices: WebChatService[];
  voiceEnabled: boolean;
  voiceActiveModel: WhisperModelSize | null;
  /** Persisted popup size in logical pixels. Never stored below the 920×520 floor. */
  popupWidth: number;
  popupHeight: number;
  /**
   * Per-user quick-commands surfaced as buttons in the Terminal header.
   * Each writes its `command` followed by a newline into the PTY when
   * clicked, so habitual invocations (claude code, nvim, gh, …) never
   * have to be retyped.
   */
  terminalSnippets: TerminalSnippet[];
};

export type TerminalSnippet = {
  id: string;
  label: string;
  command: string;
};

export const DEFAULT_TERMINAL_SNIPPETS: TerminalSnippet[] = [
  { id: 'claude', label: 'Claude Code', command: 'claude' },
];

export type AiProvider = 'openai' | 'anthropic' | 'google' | 'custom';
export type WhisperModelSize = 'tiny' | 'base' | 'small' | 'medium';
export type WebChatService = {
  id: string;
  label: string;
  url: string;
  /**
   * Optional UA override for this service. Leave unset to use the
   * default-browser UA (Safari on macOS). Useful when a provider rejects
   * the default — e.g. some Google surfaces behave differently for Chrome
   * vs Safari UAs.
   */
  userAgent?: string | null;
};

export const DEFAULT_WEB_SERVICES: WebChatService[] = [
  { id: 'gemini', label: 'Gemini', url: 'https://gemini.google.com/app' },
];

export const DEFAULT_SETTINGS: Settings = {
  maxHistoryItems: 1000,
  launchAtLogin: false,
  downloadsFolder: null,
  notifyOnDownloadComplete: true,
  cookiesFromBrowser: null,
  maxParallelDownloads: 3,
  downloadRateLimit: null,
  historyRetentionDays: 60,
  themeMode: DEFAULT_THEME.mode,
  themeBlur: DEFAULT_THEME.blur,
  themePaneOpacity: DEFAULT_THEME.paneOpacity,
  themeAccent: DEFAULT_THEME.accent,
  translateEnabled: false,
  translateTarget: 'uk',
  translateMinChars: 6,
  translateShowNotification: true,
  aiProvider: 'google',
  aiModel: '',
  aiBaseUrl: null,
  aiSystemPrompt: '',
  aiApiKeys: {},
  aiWebServices: DEFAULT_WEB_SERVICES,
  voiceEnabled: false,
  voiceActiveModel: null,
  popupWidth: 920,
  popupHeight: 520,
  terminalSnippets: DEFAULT_TERMINAL_SNIPPETS,
};

const store = new LazyStore('settings.json', { autoSave: true, defaults: DEFAULT_SETTINGS });

export const loadSettings = async (): Promise<Settings> => {
  const keys = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];
  const entries = await Promise.all(
    keys.map(async (k) => {
      const v = await store.get<Settings[typeof k]>(k);
      return [k, v ?? DEFAULT_SETTINGS[k]] as const;
    })
  );
  return Object.fromEntries(entries) as Settings;
};

export const saveSetting = async <K extends keyof Settings>(
  key: K,
  value: Settings[K]
): Promise<void> => {
  await store.set(key, value);
};
