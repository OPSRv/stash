import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Toggle } from './Toggle';

describe('Toggle', () => {
  it('exposes role switch with aria-checked', () => {
    render(<Toggle checked={true} onChange={() => {}} label="launch" />);
    expect(screen.getByRole('switch', { name: 'launch' })).toHaveAttribute('aria-checked', 'true');
  });

  it('fires onChange with the inverted value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="x" />);
    await user.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
