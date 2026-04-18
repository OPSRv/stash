import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { SettingsShell } from './SettingsShell';

describe('SettingsShell', () => {
  it('renders tabs and defaults to General', () => {
    render(<SettingsShell />);
    expect(screen.getByRole('button', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByText(/Launch at login/)).toBeInTheDocument();
  });

  it('switches to Clipboard tab and shows history cap input', async () => {
    const user = userEvent.setup();
    render(<SettingsShell />);
    await user.click(screen.getByRole('button', { name: 'Clipboard' }));
    await waitFor(() => {
      expect(screen.getByText(/Max history items/)).toBeInTheDocument();
    });
  });

  it('switches to About tab', async () => {
    const user = userEvent.setup();
    render(<SettingsShell />);
    await user.click(screen.getByRole('button', { name: 'About' }));
    expect(screen.getByText('Stash')).toBeInTheDocument();
  });
});
