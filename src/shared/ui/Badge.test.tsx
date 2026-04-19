import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Badge } from './Badge';

describe('Badge', () => {
  it('renders children', () => {
    render(<Badge>4K</Badge>);
    expect(screen.getByText('4K')).toBeInTheDocument();
  });

  it('defaults to neutral tone class', () => {
    const { container } = render(<Badge>x</Badge>);
    expect((container.firstChild as HTMLElement).className).toContain('stash-badge--neutral');
  });

  it('applies danger tone', () => {
    const { container } = render(<Badge tone="danger">x</Badge>);
    expect((container.firstChild as HTMLElement).className).toContain('stash-badge--danger');
  });

  it('applies custom color override via style', () => {
    const { container } = render(
      <Badge color="#E1306C" bg="rgba(225,48,108,0.16)">Instagram</Badge>,
    );
    const el = container.firstChild as HTMLElement;
    expect(el.style.color).toBe('rgb(225, 48, 108)');
    expect(el.style.backgroundColor || el.style.background).toContain('rgba(225, 48, 108');
  });
});
