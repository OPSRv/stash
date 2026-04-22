import { describe, expect, it } from 'vitest';
import { accent, accentSolid } from './accent';

describe('accent', () => {
  it('interpolates opacity into the rgba template', () => {
    expect(accent(0.18)).toBe('rgba(var(--stash-accent-rgb), 0.18)');
    expect(accent(1)).toBe('rgba(var(--stash-accent-rgb), 1)');
    expect(accent(0)).toBe('rgba(var(--stash-accent-rgb), 0)');
  });

  it('accentSolid returns a plain rgb reference', () => {
    expect(accentSolid()).toBe('rgb(var(--stash-accent-rgb))');
  });
});
