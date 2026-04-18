import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Kbd } from './Kbd';

describe('Kbd', () => {
  it('renders its children inside a kbd class', () => {
    render(<Kbd>⌘</Kbd>);
    const el = screen.getByText('⌘');
    expect(el).toHaveClass('kbd');
    expect(el.tagName).toBe('SPAN');
  });

  it('renders a sequence when given multiple children', () => {
    render(
      <>
        <Kbd>⌘</Kbd>
        <Kbd>K</Kbd>
      </>
    );
    expect(screen.getByText('⌘')).toBeInTheDocument();
    expect(screen.getByText('K')).toBeInTheDocument();
  });
});
