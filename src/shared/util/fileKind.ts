/// Shared extension/MIME → content-kind classifier. The whole app funnels
/// file identification through this one table so a `.json` copied from
/// clipboard, dropped into notes, or arriving as a telegram attachment
/// always renders the same way (`FilePreview` routes on `FileKind`).
///
/// Phase 1 scope: media + common code languages (js/jsx/ts/tsx/json) +
/// markdown + plaintext + PDF. Anything else falls through to `unknown`
/// and renders as a `FileChip` placeholder.

export type FileKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'code'
  | 'markdown'
  | 'text'
  | 'pdf'
  | 'unknown';

/// Languages we hand to highlight.js. Subset of the curated list in
/// `shared/ui/Markdown.tsx` — keep in sync when adding new grammars.
export type CodeLanguage =
  | 'javascript'
  | 'typescript'
  | 'json'
  | 'css'
  | 'html'
  | 'xml'
  | 'python'
  | 'rust'
  | 'go'
  | 'java'
  | 'bash'
  | 'sql'
  | 'yaml'
  | 'diff'
  | 'plaintext';

export type DetectedKind = { kind: FileKind; language?: CodeLanguage };

const EXT: Record<string, DetectedKind> = {
  // images
  png: { kind: 'image' },
  jpg: { kind: 'image' },
  jpeg: { kind: 'image' },
  gif: { kind: 'image' },
  webp: { kind: 'image' },
  avif: { kind: 'image' },
  svg: { kind: 'image' },
  bmp: { kind: 'image' },
  ico: { kind: 'image' },
  tif: { kind: 'image' },
  tiff: { kind: 'image' },

  // video
  mp4: { kind: 'video' },
  m4v: { kind: 'video' },
  mov: { kind: 'video' },
  webm: { kind: 'video' },
  mkv: { kind: 'video' },
  avi: { kind: 'video' },

  // audio
  mp3: { kind: 'audio' },
  m4a: { kind: 'audio' },
  wav: { kind: 'audio' },
  ogg: { kind: 'audio' },
  opus: { kind: 'audio' },
  flac: { kind: 'audio' },
  aiff: { kind: 'audio' },
  aif: { kind: 'audio' },
  aac: { kind: 'audio' },

  // code
  js: { kind: 'code', language: 'javascript' },
  jsx: { kind: 'code', language: 'javascript' },
  mjs: { kind: 'code', language: 'javascript' },
  cjs: { kind: 'code', language: 'javascript' },
  ts: { kind: 'code', language: 'typescript' },
  tsx: { kind: 'code', language: 'typescript' },
  json: { kind: 'code', language: 'json' },
  html: { kind: 'code', language: 'html' },
  htm: { kind: 'code', language: 'html' },
  xml: { kind: 'code', language: 'xml' },
  css: { kind: 'code', language: 'css' },
  py: { kind: 'code', language: 'python' },
  rs: { kind: 'code', language: 'rust' },
  go: { kind: 'code', language: 'go' },
  java: { kind: 'code', language: 'java' },
  sh: { kind: 'code', language: 'bash' },
  bash: { kind: 'code', language: 'bash' },
  zsh: { kind: 'code', language: 'bash' },
  sql: { kind: 'code', language: 'sql' },
  yaml: { kind: 'code', language: 'yaml' },
  yml: { kind: 'code', language: 'yaml' },
  diff: { kind: 'code', language: 'diff' },
  patch: { kind: 'code', language: 'diff' },

  // markdown
  md: { kind: 'markdown' },
  markdown: { kind: 'markdown' },
  mdx: { kind: 'markdown' },

  // plain text
  txt: { kind: 'text' },
  log: { kind: 'text' },
  csv: { kind: 'text' },
  tsv: { kind: 'text' },

  // pdf (viewer lands in Phase 1 via <embed>; placeholder kind for now)
  pdf: { kind: 'pdf' },
};

/// Exact MIME matches take priority over prefixes — `application/json`
/// must become code+json, not text+plaintext just because it starts
/// with `application/`.
const MIME_EXACT: Record<string, DetectedKind> = {
  'application/json': { kind: 'code', language: 'json' },
  'application/javascript': { kind: 'code', language: 'javascript' },
  'application/typescript': { kind: 'code', language: 'typescript' },
  'application/xml': { kind: 'code', language: 'xml' },
  'application/x-sh': { kind: 'code', language: 'bash' },
  'application/x-yaml': { kind: 'code', language: 'yaml' },
  'application/sql': { kind: 'code', language: 'sql' },
  'application/pdf': { kind: 'pdf' },
  'text/html': { kind: 'code', language: 'html' },
  'text/css': { kind: 'code', language: 'css' },
  'text/xml': { kind: 'code', language: 'xml' },
  'text/javascript': { kind: 'code', language: 'javascript' },
  'text/markdown': { kind: 'markdown' },
  'text/x-markdown': { kind: 'markdown' },
  'text/yaml': { kind: 'code', language: 'yaml' },
  'text/x-yaml': { kind: 'code', language: 'yaml' },
  'text/x-diff': { kind: 'code', language: 'diff' },
};

const MIME_PREFIX: Array<[string, DetectedKind]> = [
  ['image/', { kind: 'image' }],
  ['video/', { kind: 'video' }],
  ['audio/', { kind: 'audio' }],
  ['text/', { kind: 'text' }],
];

/// Pull the extension out of a filename, bare URL, or absolute path.
/// Strips query/fragment and normalises to lowercase. Returns `''` when
/// there's no dot in the basename.
export const extOf = (name: string): string => {
  const clean = name.split(/[?#]/, 1)[0];
  const base = clean.split('/').pop() ?? clean;
  const i = base.lastIndexOf('.');
  if (i <= 0) return '';
  return base.slice(i + 1).toLowerCase();
};

/// Resolve a file to a `{kind, language?}` pair. Filename wins over
/// MIME when both are supplied — our detection table has more specific
/// entries per ext, and MIME types from the OS are often generic
/// (`application/octet-stream`, `text/plain`).
export const detectFileKind = (opts: {
  name?: string | null;
  mime?: string | null;
}): DetectedKind => {
  const name = opts.name ?? '';
  if (name) {
    const ext = extOf(name);
    if (ext && EXT[ext]) return EXT[ext];
  }
  const mime = (opts.mime ?? '').toLowerCase().trim();
  if (mime) {
    if (MIME_EXACT[mime]) return MIME_EXACT[mime];
    for (const [prefix, hit] of MIME_PREFIX) {
      if (mime.startsWith(prefix)) return hit;
    }
  }
  return { kind: 'unknown' };
};

/// Convenience: are we rendering something the user can read as text?
/// Drives whether `FilePreview` needs to fetch the body before
/// rendering it.
export const isTextual = (kind: FileKind): boolean =>
  kind === 'code' || kind === 'markdown' || kind === 'text';
