import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { TabButton } from './TabButton';

describe('TabButton', () => {
  it('shows shortcut hint only on the active tab', () => {
    const { rerender } = render(
      <TabButton label="Clipboard" shortcutHint="⌘1" active={false} onClick={() => {}} />
    );
    expect(screen.getByRole('button', { name: /Clipboard/ })).toBeInTheDocument();
    expect(screen.queryByText('⌘1')).not.toBeInTheDocument();
    rerender(<TabButton label="Clipboard" shortcutHint="⌘1" active onClick={() => {}} />);
    expect(screen.getByText('⌘1')).toBeInTheDocument();
  });

  it('exposes the shortcut via the title attribute on hover', () => {
    render(<TabButton label="Clipboard" shortcutHint="⌘1" active={false} onClick={() => {}} />);
    expect(screen.getByRole('button', { name: /Clipboard/ })).toHaveAttribute(
      'title',
      'Clipboard (⌘1)'
    );
  });

  it('calls onClick when clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<TabButton label="Downloads" shortcutHint="⌘2" active={false} onClick={onClick} />);

    await user.click(screen.getByRole('button', { name: /Downloads/ }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('marks active state via aria-current="true"', () => {
    render(<TabButton label="Clipboard" shortcutHint="⌘1" active onClick={() => {}} />);
    expect(screen.getByRole('button', { name: /Clipboard/ })).toHaveAttribute('aria-current', 'true');
  });

  it('omits aria-current when inactive', () => {
    render(<TabButton label="Clipboard" shortcutHint="⌘1" active={false} onClick={() => {}} />);
    expect(screen.getByRole('button', { name: /Clipboard/ })).not.toHaveAttribute('aria-current');
  });
});
