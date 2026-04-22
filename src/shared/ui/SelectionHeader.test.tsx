import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { SelectionHeader } from './SelectionHeader';

describe('SelectionHeader', () => {
  it('renders total when nothing is selected', () => {
    render(<SelectionHeader total={12} selected={0} onToggleAll={() => {}} />);
    expect(screen.getByText('12 items')).toBeInTheDocument();
  });

  it('shows "selected" counter when partial', () => {
    render(<SelectionHeader total={12} selected={3} onToggleAll={() => {}} />);
    expect(screen.getByText('3 of 12 selected')).toBeInTheDocument();
    const cb = screen.getByRole('checkbox') as HTMLInputElement;
    expect(cb.indeterminate).toBe(true);
  });

  it('is fully checked when selected === total', () => {
    render(<SelectionHeader total={4} selected={4} onToggleAll={() => {}} />);
    const cb = screen.getByRole('checkbox') as HTMLInputElement;
    expect(cb).toHaveAttribute('aria-checked', 'true');
  });

  it('fires onToggleAll(true) when partial → click', async () => {
    const user = userEvent.setup();
    const onToggleAll = vi.fn();
    render(<SelectionHeader total={10} selected={3} onToggleAll={onToggleAll} />);
    await user.click(screen.getByRole('checkbox'));
    expect(onToggleAll).toHaveBeenCalledWith(true);
  });

  it('fires onToggleAll(false) when fully checked → click', async () => {
    const user = userEvent.setup();
    const onToggleAll = vi.fn();
    render(<SelectionHeader total={4} selected={4} onToggleAll={onToggleAll} />);
    await user.click(screen.getByRole('checkbox'));
    expect(onToggleAll).toHaveBeenCalledWith(false);
  });
});
