import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Card } from './Card';

describe('Card', () => {
  it('renders children', () => {
    render(<Card>content</Card>);
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  it('defaults to non-interactive div without button role', () => {
    render(<Card>x</Card>);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('becomes interactive button when onClick is set', async () => {
    const onClick = vi.fn();
    render(<Card onClick={onClick}>x</Card>);
    const btn = screen.getByRole('button');
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('applies ring-focus class when interactive', () => {
    render(<Card onClick={() => {}}>x</Card>);
    expect(screen.getByRole('button').className).toContain('ring-focus');
  });

  it('applies danger tone classes', () => {
    const { container } = render(<Card tone="danger">x</Card>);
    expect((container.firstChild as HTMLElement).className).toContain('stash-card--danger');
  });

  it('supports elevation=raised', () => {
    const { container } = render(<Card elevation="raised">x</Card>);
    expect((container.firstChild as HTMLElement).className).toContain('pane-elev');
  });
});
