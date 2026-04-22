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
 *  bytes-loader (needed so WKWebView gets a Blob URL instead of
 *  `asset://`, which fails on some macOS builds). */
export const MarkdownAudioPlayer = ({ src, caption }: Props) => (
  <AudioPlayer src={src} loader="bytes" display="waveform" caption={caption} />
);
