/** Audio file extensions that trigger inline-player rendering inside
 *  markdown. Kept in sync with the Rust-side `ALLOWED_AUDIO_EXT` whitelist
 *  so every embed we produce also survives the server-side validators. */
const AUDIO_EXTS = new Set([
  'mp3',
  'm4a',
  'mp4',
  'wav',
  'webm',
  'ogg',
  'aac',
  'flac',
  'opus',
  'aiff',
  'aif',
]);

const IMAGE_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'heic',
  'heif',
]);

/// Video container extensions that promote a markdown `![…](…)` embed
/// into the inline `<video>` player. Mirrors the Rust-side
/// `ALLOWED_VIDEO_EXT`. Note the overlap with audio (`webm`, `mp4`):
/// `isVideoSrc` is checked AFTER `isAudioSrc` callers — see
/// `MarkdownPreview` — because a `.mp4` saved via the audio dir lives
/// under that root and should keep playing as audio there. Files saved
/// via the video dir are scoped separately at the media-server layer.
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi']);

const extOf = (src: string): string => {
  // Strip query/fragment so `foo.mp3?v=1` still classifies correctly. `?`
  // and `#` are valid in URLs but never in the on-disk portion of our paths.
  const clean = src.split(/[?#]/, 1)[0];
  const dot = clean.lastIndexOf('.');
  return dot <= 0 ? '' : clean.slice(dot + 1).toLowerCase();
};

export const isAudioSrc = (src: string | undefined | null): boolean => {
  if (!src) return false;
  return AUDIO_EXTS.has(extOf(src));
};

export const isImageSrc = (src: string | undefined | null): boolean => {
  if (!src) return false;
  return IMAGE_EXTS.has(extOf(src));
};

export const isVideoSrc = (src: string | undefined | null): boolean => {
  if (!src) return false;
  return VIDEO_EXTS.has(extOf(src));
};

/** Escape markdown link chars in the path so exotic filenames round-trip
 *  intact. Embed uses `<...>` angle-bracket variant whenever the path
 *  contains spaces or parens — the CommonMark-safe way to wrap file refs. */
export const formatEmbedSrc = (path: string): string => {
  if (/[()\s]/.test(path)) return `<${path.replace(/[<>]/g, '\\$&')}>`;
  return path;
};

/** Rewrite any `[label](path)` / `![alt](path)` whose `path` contains a
 *  space or paren *and* isn't already wrapped in `<…>` so it becomes
 *  CommonMark-valid (`<path>`-style). Idempotent: already-wrapped or
 *  space-free refs pass through untouched.
 *
 *  Why: notes saved before `buildImageEmbed`/`buildAudioEmbed` was
 *  introduced — and any markdown the user hand-types or drops in from
 *  another tool — frequently use `![image](/Users/.../Application Support/…)`
 *  with bare spaces, which CommonMark refuses to parse as a link/image
 *  (the space terminates the URL token). Running `normaliseEmbedSrc` on
 *  the source right before rendering means those notes still display
 *  the embed instead of the raw `![image](…)` text.
 *
 *  Scope is tight on purpose: only `[…](…)` shapes (no autolinks, no
 *  `[label][ref]` definitions), and the path can't contain `(` or `)`
 *  itself (those are real ambiguous cases best left alone). */
export const normaliseEmbedSrc = (source: string): string =>
  source.replace(
    /(!?\[[^\]\n]*\])\(([^<\n][^()\n]*)\)/g,
    (match, prefix: string, path: string) => {
      if (!/[\s]/.test(path)) return match;
      const escaped = path.replace(/[<>]/g, '\\$&');
      return `${prefix}(<${escaped}>)`;
    },
  );

const escapeAlt = (s: string): string => s.replace(/([\\[\]])/g, '\\$1');

/** Build the markdown snippet we append/insert for a freshly saved audio
 *  file. Wrapped in blank lines so it renders as its own block even when
 *  the surrounding text is tight. */
export const buildAudioEmbed = (path: string, caption = 'voice note'): string =>
  `![${escapeAlt(caption)}](${formatEmbedSrc(path)})`;

/** Same as `buildAudioEmbed` but for images — the caption doubles as alt
 *  text for screen-readers and becomes the fallback if the image fails. */
export const buildImageEmbed = (path: string, caption = 'image'): string =>
  `![${escapeAlt(caption)}](${formatEmbedSrc(path)})`;

/** Markdown snippet for an inline video embed. Same `![alt](path)` shape
 *  as audio/image — `MarkdownPreview` dispatches on `isVideoSrc` to swap
 *  the renderer for `<video>`. */
export const buildVideoEmbed = (path: string, caption = 'video'): string =>
  `![${escapeAlt(caption)}](${formatEmbedSrc(path)})`;

const appendEmbed = (body: string, embed: string): string => {
  if (!body.trim()) return `${embed}\n`;
  const trimmed = body.replace(/\s+$/, '');
  return `${trimmed}\n\n${embed}\n`;
};

/** Append an audio embed to `body`, ensuring blank-line separation before
 *  and after so the markdown parser treats it as a standalone block. The
 *  returned body preserves the user's trailing newline (if any). */
export const appendAudioEmbed = (body: string, path: string, caption?: string): string =>
  appendEmbed(body, buildAudioEmbed(path, caption));

export const appendImageEmbed = (body: string, path: string, caption?: string): string =>
  appendEmbed(body, buildImageEmbed(path, caption));

export const appendVideoEmbed = (body: string, path: string, caption?: string): string =>
  appendEmbed(body, buildVideoEmbed(path, caption));

/** Insert an audio embed at `cursor` inside `body`, expanding to a standalone
 *  block by adding surrounding blank lines when needed. Returns the new body
 *  and the caret position after the insertion so the editor can restore
 *  focus without the embed sweeping the cursor away. */
export const insertAudioEmbedAt = (
  body: string,
  cursor: number,
  path: string,
  caption?: string
): { body: string; cursor: number } => {
  const clampedCursor = Math.max(0, Math.min(cursor, body.length));
  if (clampedCursor === body.length) {
    const next = appendAudioEmbed(body, path, caption);
    return { body: next, cursor: next.length };
  }
  const before = body.slice(0, clampedCursor);
  const after = body.slice(clampedCursor);
  const embed = buildAudioEmbed(path, caption);
  // Ensure a blank line before & after the embed. `before` may already end
  // with newlines; normalise to exactly one blank line on each side.
  const beforeNl = before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const afterNl = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const composed = `${before}${beforeNl}${embed}${afterNl}${after}`;
  return { body: composed, cursor: before.length + beforeNl.length + embed.length + afterNl.length };
};

/** Insert a transcript block right after `embedPath`'s embed, on its own
 *  paragraph. If the embed isn't found, falls back to appending the
 *  transcript at the end of the body (so we never silently drop text). */
export const insertTranscriptAfterEmbed = (
  body: string,
  embedPath: string,
  transcript: string
): string => {
  const trimmed = transcript.trim();
  if (!trimmed) return body;
  // Match `![...](path)` or `![...](<path>)`. Path may contain regex
  // metachars (spaces, dots) so escape before splicing into the pattern.
  const escaped = embedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`!\\[[^\\]]*\\]\\(<?${escaped}>?\\)`);
  const m = re.exec(body);
  if (!m) return `${body.replace(/\s+$/, '')}\n\n${trimmed}\n`;
  const end = m.index + m[0].length;
  const after = body.slice(end);
  const prefix = body.slice(0, end);
  // Collapse the transcript's leading whitespace so our blank-line framing
  // is canonical regardless of whisper's output.
  const tailStartsWithBreak = after.startsWith('\n\n') || after === '';
  const insertion = tailStartsWithBreak ? `\n\n${trimmed}` : `\n\n${trimmed}\n`;
  return `${prefix}${insertion}${after}`;
};
