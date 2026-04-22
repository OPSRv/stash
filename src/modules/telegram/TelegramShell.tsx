import { InboxPanel } from './sections/InboxPanel';

/// Inbox-only Telegram view. Connection/alerts/memory/prompt moved to
/// Settings → Telegram — the inbox stays here because it's the one
/// surface the user reaches for repeatedly, and forcing a second hop
/// through Settings every time would be punishing.
export function TelegramShell() {
  const openSettings = () => {
    window.dispatchEvent(new CustomEvent('stash:navigate', { detail: 'settings' }));
    // Let the Settings shell mount before we ask it to switch section.
    queueMicrotask(() => {
      window.dispatchEvent(
        new CustomEvent('stash:settings-section', { detail: 'telegram' }),
      );
    });
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
        <div className="text-[11px] font-medium uppercase tracking-wider text-white/40">
          Inbox
        </div>
        <button
          type="button"
          onClick={openSettings}
          className="inline-flex items-center gap-1.5 text-[11px] font-medium text-white/60 hover:text-white/90 transition-colors px-2 py-1 rounded-md hover:bg-white/5"
          aria-label="Open Telegram settings"
          title="Telegram settings"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
          Settings
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <InboxPanel />
      </div>
    </div>
  );
}
