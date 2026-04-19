import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('renders title and description', () => {
    render(<EmptyState title="No items" description="Start by copying something" />);
    expect(screen.getByText('No items')).toBeInTheDocument();
    expect(screen.getByText('Start by copying something')).toBeInTheDocument();
  });

  it('renders icon slot', () => {
    render(<EmptyState title="t" icon={<span data-testid="i" />} />);
    expect(screen.getByTestId('i')).toBeInTheDocument();
  });

  it('renders action slot and fires click', async () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        title="t"
        action={<button onClick={onClick}>Go</button>}
      />,
    );
    await userEvent.click(screen.getByText('Go'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('uses role="status" so a11y announces it', () => {
    render(<EmptyState title="t" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('respects compact variant sizing', () => {
    render(<EmptyState title="t" variant="compact" />);
    expect(screen.getByRole('status').className).toContain('py-6');
  });
});
