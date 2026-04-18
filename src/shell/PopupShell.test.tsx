import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PopupShell } from './PopupShell';

describe('PopupShell', () => {
  it('renders a tab for every registered module', () => {
    render(<PopupShell />);
    expect(screen.getByRole('button', { name: /Clipboard/ })).toBeInTheDocument();
  });

  it('marks the first module as active on mount', () => {
    render(<PopupShell />);
    expect(screen.getByRole('button', { name: /Clipboard/ })).toHaveAttribute('aria-current', 'true');
  });
});
