/// Module-level handoff for the Dev tab. The shell sets a pending
/// tool-id (and optional payload) when something outside the Dev tab
/// — e.g. a JWT landing in the clipboard — should auto-open a
/// specific dev tile. `DevShell` consumes it on mount so the route
/// survives the gap between `openTab('dev')` and the lazy chunk
/// finishing its import. Mirrors the contract used by the Downloader's
/// `pendingUrl` slot.
export interface PendingDevTool {
  toolId: string;
  /// Free-form payload handed to the tool view. Each tool that opts
  /// into auto-open documents its own shape (e.g. the JWT tool reads
  /// a `token: string`).
  payload?: unknown;
}

let pending: PendingDevTool | null = null;

export function setPendingDevTool(value: PendingDevTool | null): void {
  pending = value;
}

export function takePendingDevTool(): PendingDevTool | null {
  const v = pending;
  pending = null;
  return v;
}

export function peekPendingDevTool(): PendingDevTool | null {
  return pending;
}

/// Event fired alongside `setPendingDevTool` so an already-mounted
/// `DevShell` can react without waiting for a remount. Detail mirrors
/// the slot payload.
export const DEV_OPEN_TOOL_EVENT = 'stash:dev-open-tool';
