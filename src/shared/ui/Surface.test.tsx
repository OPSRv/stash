import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Surface } from './Surface';

describe('Surface', () => {
  it('renders children', () => {
    render(<Surface>Hi</Surface>);
    expect(screen.getByText('Hi')).toBeInTheDocument();
  });

  it('applies pane class', () => {
    const { container } = render(<Surface>x</Surface>);
    expect((container.firstChild as HTMLElement).className).toContain('pane');
  });

  it('applies pane-elev when elevation=raised', () => {
    const { container } = render(<Surface elevation="raised">x</Surface>);
    expect((container.firstChild as HTMLElement).className).toContain('pane-elev');
  });

  it('applies rounded class', () => {
    const { container } = render(<Surface rounded="2xl">x</Surface>);
    expect((container.firstChild as HTMLElement).className).toContain('rounded-2xl');
  });

  it('forwards extra HTMLAttributes', () => {
    const { container } = render(<Surface data-testid="s">x</Surface>);
    expect((container.firstChild as HTMLElement).getAttribute('data-testid')).toBe('s');
  });
});
