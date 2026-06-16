// Event contract for "open this image in Canvas" hand-offs from other modules
// (e.g. the Clipboard tab). The sender copies the image to the OS clipboard,
// navigates here via `stash:navigate`, then dispatches this event (a couple of
// times, to survive Canvas's lazy mount); the Canvas shell responds by pasting
// the clipboard image. String contract only — no cross-module imports.

export const CANVAS_PASTE_EVENT = 'stash:canvas-paste';
