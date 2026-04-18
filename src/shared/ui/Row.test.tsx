import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Row } from './Row';

describe('Row', () => {
  it('renders primary and secondary text', () => {
    render(<Row primary="hello" secondary="Mail · inbox" />);
    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(screen.getByText('Mail · inbox')).toBeInTheDocument();
  });

  it('renders icon slot when provided', () => {
    render(<Row primary="x" icon={<span data-testid="icon">i</span>} />);
    expect(screen.getByTestId('icon')).toBeInTheDocument();
  });

  it('renders meta slot (timestamp, shortcut)', () => {
    render(<Row primary="x" meta={<span>4m</span>} />);
    expect(screen.getByText('4m')).toBeInTheDocument();
  });

  it('calls onSelect when clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Row primary="clickme" onSelect={onSelect} />);
    await user.click(screen.getByText('clickme'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('applies row-active styling when active', () => {
    render(<Row primary="x" active />);
    expect(screen.getByRole('option')).toHaveClass('row-active');
  });

  it('sets aria-selected when active', () => {
    render(<Row primary="x" active />);
    expect(screen.getByRole('option')).toHaveAttribute('aria-selected', 'true');
  });

  it('applies row-pinned styling when pinned and not active', () => {
    render(<Row primary="x" pinned />);
    expect(screen.getByRole('option')).toHaveClass('row-pinned');
  });
});
