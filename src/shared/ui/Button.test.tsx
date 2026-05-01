import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Button } from './Button';

describe('Button', () => {
  it('renders children and fires onClick', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click me</Button>);
    fireEvent.click(screen.getByText('Click me'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not fire when disabled', () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        X
      </Button>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('does not fire when loading and renders spinner', () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} loading>
        X
      </Button>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('applies solid+accent → btn-primary token', () => {
    render(<Button variant="solid" tone="accent">P</Button>);
    expect(screen.getByRole('button').className).toContain('btn-primary');
  });

  it('applies soft+danger → btn-danger token', () => {
    render(<Button variant="soft" tone="danger">D</Button>);
    expect(screen.getByRole('button').className).toContain('btn-danger');
  });

  it('applies ghost+neutral → transparent default with hover lift', () => {
    // Refresh-2026-04: ghost lost its 0.06 default tint; it's now fully
    // transparent until hover. Assert the canonical hover utility instead
    // of the retired `.btn-ghost` token.
    render(<Button>G</Button>);
    expect(screen.getByRole('button').className).toMatch(/hover:\[background:var\(--bg-hover\)\]/);
  });

  it('applies size class', () => {
    const { rerender } = render(<Button size="xs">x</Button>);
    expect(screen.getByRole('button').className).toContain('h-5');
    rerender(<Button size="lg">x</Button>);
    // Refresh-2026-04: lg shrinks 36 → 32 px.
    expect(screen.getByRole('button').className).toContain('h-8');
  });

  it('applies shape pill', () => {
    render(<Button shape="pill">x</Button>);
    expect(screen.getByRole('button').className).toContain('rounded-full');
  });

  it('applies fullWidth', () => {
    render(<Button fullWidth>x</Button>);
    expect(screen.getByRole('button').className).toContain('w-full');
  });

  it('stops propagation when stopPropagation is set', () => {
    const parent = vi.fn();
    const onClick = vi.fn();
    render(
      <div onClick={parent}>
        <Button onClick={onClick} stopPropagation>
          X
        </Button>
      </div>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalled();
    expect(parent).not.toHaveBeenCalled();
  });

  it('renders leadingIcon and trailingIcon', () => {
    render(
      <Button leadingIcon={<span data-testid="lead" />} trailingIcon={<span data-testid="trail" />}>
        X
      </Button>,
    );
    expect(screen.getByTestId('lead')).toBeInTheDocument();
    expect(screen.getByTestId('trail')).toBeInTheDocument();
  });
});
