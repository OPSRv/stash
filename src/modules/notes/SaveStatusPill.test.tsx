import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SaveStatusPill } from './SaveStatusPill';

describe('SaveStatusPill', () => {
  it('renders nothing when idle', () => {
    const { container } = render(<SaveStatusPill status="idle" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders "Saving…" while saving', () => {
    render(<SaveStatusPill status="saving" />);
    expect(screen.getByText('Saving…')).toBeInTheDocument();
  });

  it('renders "Saved" after success', () => {
    render(<SaveStatusPill status="saved" />);
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('applies danger tone on error', () => {
    render(<SaveStatusPill status="error" />);
    const el = screen.getByText('Save failed');
    expect(el.className).toContain('stash-badge--danger');
  });

  it('is aria-live=polite for a11y announcement', () => {
    render(<SaveStatusPill status="saving" />);
    expect(screen.getByText('Saving…')).toHaveAttribute('aria-live', 'polite');
  });
});
