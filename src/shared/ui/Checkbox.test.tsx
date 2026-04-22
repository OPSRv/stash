import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Checkbox } from './Checkbox';

describe('Checkbox', () => {
  it('exposes native checkbox role with aria-checked', () => {
    render(<Checkbox checked ariaLabel="pin" onChange={() => {}} />);
    expect(screen.getByRole('checkbox', { name: 'pin' })).toHaveAttribute('aria-checked', 'true');
  });

  it('reports mixed when indeterminate', () => {
    render(<Checkbox checked={false} indeterminate ariaLabel="all" onChange={() => {}} />);
    const cb = screen.getByRole('checkbox', { name: 'all' }) as HTMLInputElement;
    expect(cb.indeterminate).toBe(true);
    expect(cb).toHaveAttribute('aria-checked', 'mixed');
  });

  it('fires onChange with the inverted value on click', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} label="enable" />);
    await user.click(screen.getByLabelText('enable'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does not fire when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} label="x" disabled />);
    await user.click(screen.getByLabelText('x'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders description next to label', () => {
    render(
      <Checkbox
        checked
        onChange={() => {}}
        label="Launch on login"
        description="Starts minimised in menubar"
      />,
    );
    expect(screen.getByText('Launch on login')).toBeInTheDocument();
    expect(screen.getByText(/Starts minimised/)).toBeInTheDocument();
  });
});
