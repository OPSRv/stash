import { describe, expect, it } from 'vitest';

import { detectFileKind, extOf, isTextual } from './fileKind';

describe('extOf', () => {
  it('extracts lowercase extension from a plain filename', () => {
    expect(extOf('Photo.JPG')).toBe('jpg');
  });

  it('handles absolute paths', () => {
    expect(extOf('/Users/alice/notes/readme.md')).toBe('md');
  });

  it('strips query and fragment before reading the extension', () => {
    expect(extOf('https://x.test/file.ts?v=42#section')).toBe('ts');
  });

  it('returns empty string when the basename has no dot', () => {
    expect(extOf('Makefile')).toBe('');
  });

  it('ignores dots that are only in the directory, not the basename', () => {
    expect(extOf('/etc/some.dir/conffile')).toBe('');
  });

  it('returns empty string for hidden files without a secondary extension', () => {
    expect(extOf('.gitignore')).toBe('');
  });
});

describe('detectFileKind', () => {
  it('classifies common image extensions', () => {
    expect(detectFileKind({ name: 'a.png' })).toEqual({ kind: 'image' });
    expect(detectFileKind({ name: 'b.WEBP' })).toEqual({ kind: 'image' });
  });

  it('classifies video and audio media', () => {
    expect(detectFileKind({ name: 'clip.mov' })).toEqual({ kind: 'video' });
    expect(detectFileKind({ name: 'voice.ogg' })).toEqual({ kind: 'audio' });
  });

  it('maps JS/TS family to their highlight.js languages', () => {
    expect(detectFileKind({ name: 'app.jsx' })).toEqual({
      kind: 'code',
      language: 'javascript',
    });
    expect(detectFileKind({ name: 'App.tsx' })).toEqual({
      kind: 'code',
      language: 'typescript',
    });
    expect(detectFileKind({ name: 'data.json' })).toEqual({
      kind: 'code',
      language: 'json',
    });
  });

  it('returns markdown for .md / .mdx', () => {
    expect(detectFileKind({ name: 'README.md' })).toEqual({ kind: 'markdown' });
    expect(detectFileKind({ name: 'post.mdx' })).toEqual({ kind: 'markdown' });
  });

  it('falls through to unknown for unsupported extensions', () => {
    expect(detectFileKind({ name: 'archive.rar' })).toEqual({ kind: 'unknown' });
  });

  it('uses MIME when the filename has no usable extension', () => {
    expect(detectFileKind({ name: 'Makefile', mime: 'text/plain' })).toEqual({
      kind: 'text',
    });
    expect(
      detectFileKind({ name: 'noext', mime: 'application/json' }),
    ).toEqual({ kind: 'code', language: 'json' });
  });

  it('prefers filename extension over generic MIME', () => {
    // OS often hands us `application/octet-stream` for known files —
    // trust the extension in that case.
    expect(
      detectFileKind({
        name: 'app.tsx',
        mime: 'application/octet-stream',
      }),
    ).toEqual({ kind: 'code', language: 'typescript' });
  });

  it('matches MIME prefixes for binary media', () => {
    expect(detectFileKind({ mime: 'image/heic' })).toEqual({ kind: 'image' });
    expect(detectFileKind({ mime: 'video/quicktime' })).toEqual({
      kind: 'video',
    });
  });

  it('returns unknown when nothing matches', () => {
    expect(detectFileKind({})).toEqual({ kind: 'unknown' });
    expect(detectFileKind({ name: 'weird.xyz' })).toEqual({ kind: 'unknown' });
  });
});

describe('isTextual', () => {
  it.each(['code', 'markdown', 'text'] as const)('treats %s as textual', (k) => {
    expect(isTextual(k)).toBe(true);
  });

  it.each(['image', 'video', 'audio', 'pdf', 'unknown'] as const)(
    'treats %s as non-textual',
    (k) => {
      expect(isTextual(k)).toBe(false);
    },
  );
});
