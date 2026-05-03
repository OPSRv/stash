import { describe, expect, it } from 'vitest';
import {
  appendAudioEmbed,
  buildAudioEmbed,
  insertAudioEmbedAt,
  insertTranscriptAfterEmbed,
  isAudioSrc,
  normaliseEmbedSrc,
} from './audioEmbed';

describe('isAudioSrc', () => {
  it('matches common audio extensions', () => {
    expect(isAudioSrc('/x/y.mp3')).toBe(true);
    expect(isAudioSrc('/x/y.M4A')).toBe(true);
    expect(isAudioSrc('song.opus')).toBe(true);
  });
  it('ignores query strings and fragments', () => {
    expect(isAudioSrc('/x/y.mp3?v=2#t=10')).toBe(true);
  });
  it('rejects non-audio and missing extensions', () => {
    expect(isAudioSrc('/x/y.png')).toBe(false);
    expect(isAudioSrc('/x/no-ext')).toBe(false);
    expect(isAudioSrc(null)).toBe(false);
    expect(isAudioSrc('')).toBe(false);
  });
});

describe('buildAudioEmbed', () => {
  it('produces standard markdown image syntax for simple paths', () => {
    expect(buildAudioEmbed('/tmp/a.mp3', 'voice note')).toBe('![voice note](/tmp/a.mp3)');
  });
  it('wraps paths with spaces or parens in angle brackets', () => {
    expect(buildAudioEmbed('/tmp/My Rec (2).mp3', 'rec')).toBe(
      '![rec](</tmp/My Rec (2).mp3>)'
    );
  });
  it('escapes brackets in the caption', () => {
    expect(buildAudioEmbed('/tmp/a.mp3', 'note [alt]')).toBe('![note \\[alt\\]](/tmp/a.mp3)');
  });
});

describe('appendAudioEmbed', () => {
  it('appends to an empty body without leading blank lines', () => {
    expect(appendAudioEmbed('', '/x/a.mp3', 'rec')).toBe('![rec](/x/a.mp3)\n');
  });
  it('separates the embed from existing content with a blank line', () => {
    expect(appendAudioEmbed('hello world', '/x/a.mp3', 'rec')).toBe(
      'hello world\n\n![rec](/x/a.mp3)\n'
    );
  });
  it('normalises trailing whitespace from the existing body', () => {
    expect(appendAudioEmbed('hello\n\n\n', '/x/a.mp3', 'rec')).toBe(
      'hello\n\n![rec](/x/a.mp3)\n'
    );
  });
});

describe('insertAudioEmbedAt', () => {
  it('appends when the cursor is at end of body', () => {
    const body = 'first line';
    const r = insertAudioEmbedAt(body, body.length, '/x/a.mp3', 'r');
    expect(r.body).toBe('first line\n\n![r](/x/a.mp3)\n');
    expect(r.cursor).toBe(r.body.length);
  });
  it('inserts between paragraphs with blank-line framing', () => {
    const body = 'one\n\ntwo';
    // Cursor after "one\n\n" — between the paragraphs.
    const r = insertAudioEmbedAt(body, 5, '/x/a.mp3', 'r');
    expect(r.body).toBe('one\n\n![r](/x/a.mp3)\n\ntwo');
    // Cursor lands right after the embed.
    expect(r.body.slice(0, r.cursor)).toBe('one\n\n![r](/x/a.mp3)\n\n');
  });
  it('adds blank lines when cursor lands mid-paragraph', () => {
    const body = 'one two';
    const r = insertAudioEmbedAt(body, 3, '/x/a.mp3', 'r');
    expect(r.body).toBe('one\n\n![r](/x/a.mp3)\n\n two');
  });
});

describe('normaliseEmbedSrc', () => {
  it('wraps unquoted image paths that contain spaces in angle brackets', () => {
    const src = '![image](/Users/me/Application Support/foo.png)';
    expect(normaliseEmbedSrc(src)).toBe(
      '![image](</Users/me/Application Support/foo.png>)',
    );
  });
  it('also normalises plain markdown links with spaces in the URL', () => {
    expect(normaliseEmbedSrc('see [doc](/a b/c.md)')).toBe(
      'see [doc](</a b/c.md>)',
    );
  });
  it('leaves already angle-bracketed embeds untouched', () => {
    const src = '![rec](</tmp/My Rec (2).mp3>)';
    expect(normaliseEmbedSrc(src)).toBe(src);
  });
  it('leaves space-free paths untouched', () => {
    const src = '![ok](/no/space/path.png)';
    expect(normaliseEmbedSrc(src)).toBe(src);
  });
  it('does not rewrite paths that contain parentheses (left for the user)', () => {
    // Bare `(...)` inside the URL is genuinely ambiguous — a CommonMark
    // parser treats the first `)` as the closer. Don't try to outsmart it.
    const src = '![x](/a (b)/c d.png)';
    expect(normaliseEmbedSrc(src)).toBe(src);
  });
  it('handles multiple embeds in the same source independently', () => {
    const src = 'a ![one](/p one.png) b ![two](/p/two.png) c';
    expect(normaliseEmbedSrc(src)).toBe(
      'a ![one](</p one.png>) b ![two](/p/two.png) c',
    );
  });
  it('preserves non-link text untouched', () => {
    const src = '# heading\n\n- [ ] task\n- [x] done\n\nprose';
    expect(normaliseEmbedSrc(src)).toBe(src);
  });
});

describe('insertTranscriptAfterEmbed', () => {
  it('splices transcript right after the matching embed', () => {
    const body = 'intro\n\n![rec](/x/a.mp3)\n\nnext para';
    const out = insertTranscriptAfterEmbed(body, '/x/a.mp3', 'Hello world.');
    expect(out).toBe('intro\n\n![rec](/x/a.mp3)\n\nHello world.\n\nnext para');
  });
  it('matches angle-bracketed paths too', () => {
    const body = 'a\n\n![rec](</p (1).mp3>)\n\nb';
    const out = insertTranscriptAfterEmbed(body, '/p (1).mp3', 'Hi.');
    expect(out).toBe('a\n\n![rec](</p (1).mp3>)\n\nHi.\n\nb');
  });
  it('appends to body when the embed is not found', () => {
    const out = insertTranscriptAfterEmbed('only text', '/missing.mp3', 'hello');
    expect(out).toBe('only text\n\nhello\n');
  });
  it('is a no-op for empty transcripts', () => {
    const body = 'x\n\n![rec](/a.mp3)';
    expect(insertTranscriptAfterEmbed(body, '/a.mp3', '   ')).toBe(body);
  });
});
