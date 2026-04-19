// Minimal stub for the Tauri IPC bridge. We inject this before each test so
// `@tauri-apps/api/core#invoke()` resolves to a predictable value instead of
// throwing "window.__TAURI_INTERNALS__ is undefined" inside the dev browser.
//
// Extend the command map below to cover whatever flow the test exercises.

export const tauriMockInit = `
(() => {
  const commandResponses = {
    clipboard_list: [],
    clipboard_search: [],
    dl_list: [],
    dl_ytdlp_version: { installed: null, latest: null, path: null },
    rec_status: { available: false, recording: false, last_saved: null },
    rec_list: [],
    notes_list: [],
    global_search: [],
  };
  window.__TAURI_INTERNALS__ = {
    transformCallback: (cb) => cb,
    invoke: (cmd) =>
      Promise.resolve(cmd in commandResponses ? commandResponses[cmd] : null),
    plugins: {},
  };
})();
`;
