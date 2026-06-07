import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { TabButton } from './TabButton';

const ICON = <span data-testid="icon" />;

describe('TabButton', () => {
  it('always renders the label, even with an icon and inactive', () => {
    // Labels never collapse to icon-only any more — the rail scrolls with
    // arrows instead, so every tab shows its text at all times.
    render(<TabButton label="Clipboard" icon={ICON} active={false} onClick={() => {}} />);
    expect(screen.getByText('Clipboard')).toBeVisible();
    expect(screen.getByTestId('icon')).toBeInTheDocument();
  });

  it('renders the label for an active tab', () => {
    render(<TabButton label="Clipboard" icon={ICON} active onClick={() => {}} />);
    expect(screen.getByText('Clipboard')).toBeVisible();
  });

  it('calls onClick when clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<TabButton label="Downloads" active={false} onClick={onClick} />);

    await user.click(screen.getByRole('button', { name: /Downloads/ }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('marks active state via aria-current="true"', () => {
    render(<TabButton label="Clipboard" active onClick={() => {}} />);
    expect(screen.getByRole('button', { name: /Clipboard/ })).toHaveAttribute('aria-current', 'true');
  });

  it('omits aria-current when inactive', () => {
    render(<TabButton label="Clipboard" active={false} onClick={() => {}} />);
    expect(screen.getByRole('button', { name: /Clipboard/ })).not.toHaveAttribute('aria-current');
  });
});
