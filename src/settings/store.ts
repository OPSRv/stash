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
  /**
   * When set, every completed audio download (m4a, mp3, …) is automatically
   * handed off to the Stems separator — same wiring as the per-row "Stems"
   * button, just fired without a click. Video downloads are ignored because
   * Demucs can't read mp4/webm, and a video user almost certainly doesn't
   * want their files siphoned through 30s of demucs anyway. Off by default
   * to keep the surprise factor low; users opt in from Settings → Downloads.
   */
  downloaderAutoStems: boolean;
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
   * If set, a voice recording is sent to whisper the moment recording stops
   * — the transcript lands in the note's body without an extra click. Skipped
   * quietly when no whisper model is active.
   */
  notesAutoTranscribe: boolean;
  /**
   * If set, `polishTranscript` runs right after a successful transcribe to
   * correct typos/punctuation via the active AI provider (temperature 0,
   * no rephrasing). Skipped when no AI provider is configured.
   */
  notesAutoPolish: boolean;
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
  /** Persisted popup size in logical pixels. Never stored below the 920×640 floor. */
  popupWidth: number;
  popupHeight: number;
  /**
   * Per-user quick-commands surfaced as buttons in the Terminal header.
   * Each writes its `command` followed by a newline into the PTY when
   * clicked, so habitual invocations (claude code, nvim, gh, …) never
   * have to be retyped.
   */
  terminalSnippets: TerminalSnippet[];
  /**
   * Command launched by the dedicated Claude Code button in the terminal
   * pane header. Default is plain `claude`; advanced users override with
   * flags (e.g. `claude --model opus --dangerously-skip-permissions`).
   * Clicking the button writes this verbatim into the PTY followed by a
   * newline AND opens the Compose box, so multi-line prompts are ready
   * to type the moment the Claude CLI takes over the TTY.
   */
  terminalClaudeCommand: string;
  /**
   * Module ids the user has hidden from the popup tab bar. Stored as a
   * "what to hide" set rather than "what to show" so that adding a new
   * module to `registry.ts` automatically becomes visible — users only
   * see this list when they explicitly turn something off.
   */
  hiddenModules: string[];
  /**
   * User-defined tab order. When non-empty, modules are sorted by their
   * index here (unknown ids fall back to `registry.ts` order at the end).
   * Empty array means "use the registry default order". Settings is always
   * pinned last by the resolver regardless of what's stored.
   */
  moduleOrder: string[];
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
  /**
   * Persisted zoom level for this service, 1 = 100%. Applied when the
   * webview is embedded and bumped by the `⌘+ / ⌘- / ⌘0` shortcuts.
   * Clamped to `[0.5, 2.0]` — values outside that range tend to break
   * chat UIs and defeat the point of a narrow popup.
   */
  zoom?: number;
  /**
   * Pinned tabs live in their own section at the top of the sidebar and
   * are exempt from the stale-tab fade. Absent = unpinned.
   */
  pinned?: boolean;
};

export const DEFAULT_WEB_SERVICES: WebChatService[] = [
  { id: 'gemini', label: 'Gemini', url: 'https://gemini.google.com/app' },
];

export const DEFAULT_SETTINGS: Settings = {
  maxHistoryItems: 1000,
  launchAtLogin: false,
  downloadsFolder: null,
  notifyOnDownloadComplete: true,
  downloaderAutoStems: false,
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
  notesAutoTranscribe: true,
  notesAutoPolish: true,
  popupWidth: 920,
  popupHeight: 640,
  terminalSnippets: DEFAULT_TERMINAL_SNIPPETS,
  terminalClaudeCommand: 'claude',
  hiddenModules: [],
  moduleOrder: [],
};

const store = new LazyStore('settings.json', { autoSave: true, defaults: DEFAULT_SETTINGS });

// In-memory cache for settings. LazyStore already batches disk I/O but every
// `loadSettings()` call still does N `store.get()` awaits — a full tour of
// the settings file per mount. Popup startup triggers at least two loads
// (PopupShell + theme boot), so caching cuts ~40ms off cold open and trims
// later re-reads to a promise resolution.
let cache: Settings | null = null;
let inflight: Promise<Settings> | null = null;

const readAll = async (): Promise<Settings> => {
  const keys = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];
  const entries = await Promise.all(
    keys.map(async (k) => {
      const v = await store.get<Settings[typeof k]>(k);
      return [k, v ?? DEFAULT_SETTINGS[k]] as const;
    })
  );
  return Object.fromEntries(entries) as Settings;
};

export const loadSettings = async (): Promise<Settings> => {
  if (cache) return cache;
  if (!inflight) {
    inflight = readAll()
      .then((s) => {
        cache = s;
        return s;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
};

export const saveSetting = async <K extends keyof Settings>(
  key: K,
  value: Settings[K]
): Promise<void> => {
  await store.set(key, value);
  if (cache) cache = { ...cache, [key]: value };
};

/// Drop the in-memory cache. Useful for tests or external edits to the
/// underlying file; UI code should prefer `saveSetting` which keeps the
/// cache in sync.
export const invalidateSettingsCache = (): void => {
  cache = null;
  inflight = null;
};
