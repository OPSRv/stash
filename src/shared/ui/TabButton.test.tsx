import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { TabButton } from './TabButton';

const ICON = <span data-testid="icon" />;

describe('TabButton', () => {
  it('surfaces the label via the custom Tooltip when collapsed to icon-only', () => {
    // Inactive tabs with an icon render collapsed — the label lives in the
    // hidden Tooltip bubble so hover still reveals the tab name.
    render(<TabButton label="Clipboard" icon={ICON} active={false} onClick={() => {}} />);
    expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('Clipboard');
  });

  it('does not render a Tooltip when the label is already visible (active tab)', () => {
    render(<TabButton label="Clipboard" icon={ICON} active onClick={() => {}} />);
    expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument();
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
