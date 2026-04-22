import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GlobeLoader } from './GlobeLoader';

describe('GlobeLoader', () => {
  it('exposes a polite live region with the caption for screen readers', () => {
    render(<GlobeLoader caption="Loading notes…" />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Loading notes…');
  });

  it('defaults the screen-reader label to "Loading…" when no caption is set', () => {
    render(<GlobeLoader />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });

  it('renders the indeterminate progress strip only when a caption is provided', () => {
    const { container, rerender } = render(<GlobeLoader />);
    expect(container.querySelector('.globe-indet')).toBeNull();
    rerender(<GlobeLoader caption="Opening…" />);
    expect(container.querySelector('.globe-indet')).not.toBeNull();
  });

  it('precomputes the 60-dot halo and reuses it across mounts (object pool)', () => {
    const { container, unmount } = render(<GlobeLoader />);
    const dotsA = Array.from(
      container.querySelectorAll('.globe-ring-dot'),
    ).map((el) => `${el.getAttribute('cx')}|${el.getAttribute('cy')}`);
    expect(dotsA).toHaveLength(60);
    unmount();
    const { container: c2 } = render(<GlobeLoader />);
    const dotsB = Array.from(c2.querySelectorAll('.globe-ring-dot')).map(
      (el) => `${el.getAttribute('cx')}|${el.getAttribute('cy')}`,
    );
    expect(dotsB).toEqual(dotsA);
  });

  it('scales the SVG via the scale prop', () => {
    const { container } = render(<GlobeLoader scale={0.5} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('200');
    expect(svg.getAttribute('height')).toBe('200');
    // viewBox is fixed so the inner geometry stays pixel-identical.
    expect(svg.getAttribute('viewBox')).toBe('0 0 400 400');
  });
});
