import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { IconButton } from './IconButton';

describe('IconButton', () => {
  it('fires onClick and stops propagation by default', async () => {
    const user = userEvent.setup();
    const inner = vi.fn();
    const outer = vi.fn();
    render(
      <div onClick={outer}>
        <IconButton onClick={inner} title="Delete">
          x
        </IconButton>
      </div>
    );
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});
