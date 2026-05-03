import { invoke } from '@tauri-apps/api/core';

/// Single front door for resolving an on-disk media path to a loopback
/// `http://127.0.0.1:<port>/...?path=…&t=…` URL the renderer can hand to
/// `<audio>` / `<video>`. Backed by the shared media server in
/// `src-tauri/src/modules/media_server/` — the only path through which
/// large media plays in this app, because `asset://` does not stream
/// past AVFoundation on macOS.
///
/// Picks audio vs. video kind by extension on the Rust side. Errors if
/// the path is not registered under any module's roots (downloads,
/// notes audio/video/attachments, stems).
export const mediaStreamUrl = (path: string): Promise<string> =>
  invoke<string>('media_stream_url', { path });
