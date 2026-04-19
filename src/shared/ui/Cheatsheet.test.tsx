import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Cheatsheet } from './Cheatsheet';

describe('Cheatsheet', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<Cheatsheet open={false} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows global group and clipboard group when tab is clipboard', () => {
    render(<Cheatsheet open onClose={() => {}} tab="clipboard" />);
    expect(screen.getByText('Global')).toBeInTheDocument();
    expect(screen.getByText('Clipboard')).toBeInTheDocument();
    expect(screen.queryByText('Downloads')).not.toBeInTheDocument();
  });

  it('shows global + downloads when tab is downloads', () => {
    render(<Cheatsheet open onClose={() => {}} tab="downloads" />);
    expect(screen.getByText('Global')).toBeInTheDocument();
    expect(screen.getByText('Downloads')).toBeInTheDocument();
    expect(screen.queryByText('Clipboard')).not.toBeInTheDocument();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<Cheatsheet open onClose={onClose} />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on ?', () => {
    const onClose = vi.fn();
    render(<Cheatsheet open onClose={onClose} />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes when the backdrop is clicked but not when the inner panel is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Cheatsheet open onClose={onClose} />);
    await user.click(screen.getByText('Shortcuts'));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Close cheatsheet' }));
    expect(onClose).toHaveBeenCalled();
  });
});
