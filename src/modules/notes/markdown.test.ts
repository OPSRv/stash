import { describe, expect, it } from 'vitest';
import { parseBlocks, parseInline, toggleCheckboxAtLine } from './markdown';

describe('parseInline', () => {
  it('splits plain text and bold', () => {
    const out = parseInline('hello **world** !');
    expect(out).toEqual([
      { kind: 'text', value: 'hello ' },
      { kind: 'bold', value: 'world' },
      { kind: 'text', value: ' !' },
    ]);
  });

  it('parses inline code and links', () => {
    const out = parseInline('use `foo` or [doc](https://example.com)');
    expect(out).toContainEqual({ kind: 'code', value: 'foo' });
    expect(out).toContainEqual({
      kind: 'link',
      value: 'doc',
      href: 'https://example.com',
    });
  });
});

describe('parseBlocks', () => {
  it('recognizes headings', () => {
    const blocks = parseBlocks('# H1\n## H2\n### H3');
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1 });
    expect(blocks[2]).toMatchObject({ kind: 'heading', level: 3 });
  });

  it('parses a checklist with mixed states', () => {
    const blocks = parseBlocks('- [ ] todo\n- [x] done\n- plain');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('list');
    if (blocks[0].kind === 'list') {
      expect(blocks[0].items[0].checked).toBe(false);
      expect(blocks[0].items[1].checked).toBe(true);
      expect(blocks[0].items[2].checked).toBeNull();
    }
  });

  it('parses fenced code blocks verbatim', () => {
    const blocks = parseBlocks('```\nconst a = 1;\nconst b = 2;\n```');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ kind: 'code', value: 'const a = 1;\nconst b = 2;' });
  });

  it('joins paragraph continuation lines', () => {
    const blocks = parseBlocks('line one\nline two\n\nnew paragraph');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe('paragraph');
  });
});

describe('toggleCheckboxAtLine', () => {
  it('toggles unchecked to checked and back', () => {
    const src = '- [ ] todo\n- [x] done';
    const once = toggleCheckboxAtLine(src, 0);
    expect(once).toBe('- [x] todo\n- [x] done');
    const twice = toggleCheckboxAtLine(once, 1);
    expect(twice).toBe('- [x] todo\n- [ ] done');
  });

  it('is a no-op on non-checkbox lines', () => {
    const src = '- plain item';
    expect(toggleCheckboxAtLine(src, 0)).toBe(src);
  });
});
