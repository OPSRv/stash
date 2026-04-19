import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Spinner } from './Spinner';

describe('Spinner', () => {
  it('defaults to a 12x12 box', () => {
    const { container } = render(<Spinner />);
    const el = container.firstChild as HTMLElement;
    expect(el.style.width).toBe('12px');
    expect(el.style.height).toBe('12px');
  });

  it('honours the size prop', () => {
    const { container } = render(<Spinner size={24} />);
    const el = container.firstChild as HTMLElement;
    expect(el.style.width).toBe('24px');
    expect(el.style.height).toBe('24px');
  });

  it('is marked aria-hidden so screen readers skip it', () => {
    const { container } = render(<Spinner />);
    expect((container.firstChild as HTMLElement).getAttribute('aria-hidden')).toBe('true');
  });
});
