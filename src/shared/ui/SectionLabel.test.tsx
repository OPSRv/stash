import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SectionLabel } from './SectionLabel';

describe('SectionLabel', () => {
  it('renders the label text', () => {
    render(<SectionLabel>Pinned</SectionLabel>);
    expect(screen.getByText('Pinned')).toBeInTheDocument();
  });

  it('applies section-label class for typography', () => {
    render(<SectionLabel>Recent</SectionLabel>);
    expect(screen.getByText('Recent')).toHaveClass('section-label');
  });
});
