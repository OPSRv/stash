import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProgressBar } from './ProgressBar';

describe('ProgressBar', () => {
  it('sets aria-valuenow from value', () => {
    render(<ProgressBar value={0.5} ariaLabel="p" />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
  });

  it('clamps below 0', () => {
    render(<ProgressBar value={-1} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
  });

  it('clamps above 1', () => {
    render(<ProgressBar value={5} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  });

  it('uses prog-fill when active', () => {
    const { container } = render(<ProgressBar value={0.4} />);
    const fill = container.querySelector('[role="progressbar"] > div')!;
    expect(fill.className).toContain('prog-fill');
    expect(fill.className).not.toContain('prog-fill-paused');
  });

  it('uses prog-fill-paused when paused', () => {
    const { container } = render(<ProgressBar value={0.4} paused />);
    const fill = container.querySelector('[role="progressbar"] > div')!;
    expect(fill.className).toContain('prog-fill-paused');
  });
});
