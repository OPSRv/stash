import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CenterSpinner } from './CenterSpinner';

describe('CenterSpinner', () => {
  it('uses full height by default', () => {
    const { container } = render(<CenterSpinner />);
    expect(container.firstChild).toHaveClass('h-full');
  });

  it('switches to inline padding when asked', () => {
    const { container } = render(<CenterSpinner fit="inline" />);
    expect(container.firstChild).toHaveClass('py-10');
    expect(container.firstChild).not.toHaveClass('h-full');
  });
});
