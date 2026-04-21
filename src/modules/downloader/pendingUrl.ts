/// Module-level handoff for a video URL that the shell wants the Downloader
/// to pick up. Set it from `PopupShell` when a supported URL lands in the
/// clipboard; the Downloader reads it via `takePending()` on mount so the
/// detect flow still runs when the tab was lazily loaded *after* the event
/// fired (and there was no listener in place yet).
///
/// Keeping this out of React state is intentional: it has to survive the gap
/// between `openTab('downloads')` and the lazy chunk finishing its import.
let pending: string | null = null;

export function setPendingDownloaderUrl(url: string | null): void {
  pending = url && url.trim() ? url.trim() : null;
}

export function takePendingDownloaderUrl(): string | null {
  const url = pending;
  pending = null;
  return url;
}

/// Peek without consuming — used by tests only.
export function peekPendingDownloaderUrl(): string | null {
  return pending;
}
