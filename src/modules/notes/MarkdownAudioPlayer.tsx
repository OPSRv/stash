import { AudioPlayer } from '../../shared/ui/AudioPlayer';

type Props = {
  /** Absolute path to the audio file, as stored in the markdown
   *  `![](path)` reference. Must live under the managed audio dir so
   *  the Rust reader will accept it. */
  src: string;
  /** Markdown alt-text doubles as a human caption. */
  caption?: string;
};

/** Inline audio player for markdown-embedded audio. Thin wrapper that
 *  pins the shared `AudioPlayer` to the waveform variant + the
 *  loopback streaming loader.
 *
 *  We used to ship the `bytes` loader here — it pulled the whole file
 *  across IPC as a `Vec<u8>` and wrapped it in a Blob URL. That works
 *  for small voice recordings but hangs for anything multi-MB
 *  (Stash Stems exports, longer attachments) because JSON-serialising
 *  the bytes is O(N) and runs on the main thread. The `stream` loader
 *  hands the file off to the in-process loopback HTTP server in
 *  `notes/media_server.rs` and the `<audio>` element streams from
 *  `http://127.0.0.1:<port>/audio?…` — no IPC, no main-thread freeze,
 *  no `asset://` AVFoundation quirks. */
export const MarkdownAudioPlayer = ({ src, caption }: Props) => (
  <AudioPlayer src={src} loader="stream" display="waveform" caption={caption} />
);
