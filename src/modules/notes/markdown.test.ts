import { describe, expect, it } from 'vitest';
import { toggleCheckboxAtLine } from './markdown';

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

  it('is a no-op on out-of-range lines', () => {
    expect(toggleCheckboxAtLine('- [ ] a', 5)).toBe('- [ ] a');
  });
});
