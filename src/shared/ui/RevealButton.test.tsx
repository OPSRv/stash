import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { RevealButton } from './RevealButton';

vi.mock('@tauri-apps/plugin-opener', () => ({
  revealItemInDir: vi.fn(),
}));

const mockedReveal = vi.mocked(revealItemInDir);

describe('RevealButton', () => {
  afterEach(() => {
    mockedReveal.mockReset();
  });

  it('renders the default label in Ukrainian', () => {
    render(<RevealButton path="/tmp/x" />);
    expect(screen.getByRole('button', { name: 'Показати' })).toBeInTheDocument();
  });

  it('supports label override', () => {
    render(<RevealButton path="/tmp/x" label="Reveal" />);
    expect(screen.getByRole('button', { name: 'Reveal' })).toBeInTheDocument();
  });

  it('calls revealItemInDir on click', async () => {
    mockedReveal.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<RevealButton path="/tmp/example" />);
    await user.click(screen.getByRole('button'));
    expect(mockedReveal).toHaveBeenCalledWith('/tmp/example');
  });

  it('swallows reveal errors without throwing', async () => {
    mockedReveal.mockRejectedValue(new Error('denied'));
    const user = userEvent.setup();
    render(<RevealButton path="/tmp/bad" />);
    await user.click(screen.getByRole('button'));
    expect(mockedReveal).toHaveBeenCalled();
  });
});
