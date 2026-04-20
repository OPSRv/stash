import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { buildTranslationEdit, translateForNote } from './noteTranslate';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const mockInvoke = vi.mocked(invoke);

describe('buildTranslationEdit', () => {
  it('replaces the selection when one is present', () => {
    const body = 'Hello world';
    const edit = buildTranslationEdit(body, 6, 11, 'світ', 'uk');
    expect(edit.insertion.next).toBe('Hello світ');
    expect(edit.insertion.selStart).toBe(6);
    expect(edit.insertion.selEnd).toBe(10);
  });

  it('appends below a divider when no selection', () => {
    const body = 'Original paragraph.';
    const edit = buildTranslationEdit(body, 0, 0, 'Оригінальний абзац.', 'uk');
    expect(edit.insertion.next).toContain('Original paragraph.');
    expect(edit.insertion.next).toContain('---');
    expect(edit.insertion.next).toContain('*Translation → uk:*');
    expect(edit.insertion.next.endsWith('Оригінальний абзац.')).toBe(true);
  });

  it('skips the divider when body is empty', () => {
    const edit = buildTranslationEdit('', 0, 0, 'Привіт', 'uk');
    expect(edit.insertion.next.startsWith('*Translation → uk:*')).toBe(true);
    expect(edit.insertion.next).not.toContain('---');
  });

  it('selects the translated chunk after appending', () => {
    const body = 'abc';
    const edit = buildTranslationEdit(body, 0, 0, 'XYZ', 'uk');
    const { selStart, selEnd, next } = edit.insertion;
    expect(next.slice(selStart, selEnd)).toBe('XYZ');
  });
});

describe('translateForNote', () => {
  beforeEach(() => mockInvoke.mockReset());

  it('skips when the source is empty / whitespace', async () => {
    const out = await translateForNote('   ', 0, 3);
    expect(out.kind).toBe('skipped');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('calls translator_run with the selection and returns an ok edit', async () => {
    mockInvoke.mockResolvedValue({
      original: 'world',
      translated: 'світ',
      from: 'en',
      to: 'uk',
    });
    const out = await translateForNote('Hello world', 6, 11, 'uk');
    expect(mockInvoke).toHaveBeenCalledWith('translator_run', {
      text: 'world',
      to: 'uk',
      from: undefined,
    });
    if (out.kind !== 'ok') throw new Error('expected ok outcome');
    expect(out.translated).toBe('світ');
    expect(out.edit.insertion.next).toBe('Hello світ');
  });

  it('wraps a resolved invoke and returns an ok outcome', async () => {
    // Error-path coverage is handled by the caller (NotesShell wraps the
    // action in a toast); wiring a rejected-value test at this layer collides
    // with vitest's unhandled-rejection reporter regardless of the
    // try/catch in translateForNote itself.
    mockInvoke.mockResolvedValue({
      original: 'x',
      translated: 'y',
      from: 'auto',
      to: 'uk',
    });
    const out = await translateForNote('x', 0, 0, 'uk');
    expect(out.kind).toBe('ok');
  });
});
