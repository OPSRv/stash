/// Limits enforced on the source textarea. Google's endpoint will reject
/// anything much larger than this, so we stop the user before the round-trip.
export const MAX_CHARS = 5000;
export const WARN_CHARS = 4500;

/// Debounce windows (ms) for auto-translate while typing and for history
/// search. Short enough to feel live, long enough to collapse bursts.
export const AUTO_TRANSLATE_DEBOUNCE_MS = 450;
export const HISTORY_SEARCH_DEBOUNCE_MS = 150;

/// Row count past which the history list switches to react-virtual. Below
/// the threshold the plain `.map` render is faster and easier to test.
export const VIRTUALIZE_THRESHOLD = 40;
