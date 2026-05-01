import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SaveStatusPill } from './SaveStatusPill';

describe('SaveStatusPill', () => {
  // Refresh-2026-04: idle now renders the same "Saved" indicator instead
  // of returning null — the resting state is part of the visual language.
  it('renders the "Saved" indicator when idle', () => {
    render(<SaveStatusPill status="idle" />);
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('renders "Saving…" while saving', () => {
    render(<SaveStatusPill status="saving" />);
    expect(screen.getByText('Saving…')).toBeInTheDocument();
  });

  it('renders "Saved" after success', () => {
    render(<SaveStatusPill status="saved" />);
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('signals the error state via data-state', () => {
    // The previous chip used a `.stash-badge--danger` class to convey state;
    // the new dot indicator drives colour off `data-state="error"` on the
    // wrapper. Assert the new contract.
    render(<SaveStatusPill status="error" />);
    const wrapper = screen
      .getByText('Save failed')
      .closest('[data-state]') as HTMLElement;
    expect(wrapper).toBeTruthy();
    expect(wrapper.dataset.state).toBe('error');
  });

  it('is aria-live=polite for a11y announcement', () => {
    render(<SaveStatusPill status="saving" />);
    const wrapper = screen
      .getByText('Saving…')
      .closest('[aria-live]') as HTMLElement;
    expect(wrapper).toHaveAttribute('aria-live', 'polite');
  });
});
