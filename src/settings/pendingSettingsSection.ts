/// Cross-tab deep-link handoff for "open Settings → <section>".
///
/// The naive sequence — dispatch `stash:navigate` then immediately
/// `stash:settings-section` — races: `stash:navigate` only schedules
/// the Settings tab to mount lazily, so the second event fires before
/// the section listener is registered and gets dropped on the floor.
///
/// To plug that race we stash the requested section in a module-level
/// slot that the Settings shell reads on mount. Callers no longer fire
/// the section event themselves — they call `requestSettingsSection`
/// and let `stash:navigate` do the rest. The shell still listens for
/// the live event so re-clicking the same deep link from inside
/// Settings (when the popup is already on the Settings tab) keeps
/// working without a roundabout.
let pending: string | null = null;

export const requestSettingsSection = (id: string): void => {
  pending = id;
};

/// Read-and-clear the pending section. Returns `null` when none is
/// queued. Designed so SettingsShell can call this once on mount
/// without worrying about the value getting reapplied on later
/// re-mounts.
export const consumeSettingsSection = (): string | null => {
  const v = pending;
  pending = null;
  return v;
};
