import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BeatStrip } from './BeatStrip';

describe('BeatStrip', () => {
  it('renders one switch per beat with accent reflected in aria-checked', () => {
    render(
      <BeatStrip
        numerator={4}
        accents={[true, false, false, true]}
        activeBeat={1}
        onToggleAccent={() => {}}
      />,
    );
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(4);
    expect(switches[0]).toHaveAttribute('aria-checked', 'true');
    expect(switches[1]).toHaveAttribute('aria-checked', 'false');
    expect(switches[3]).toHaveAttribute('aria-checked', 'true');
  });

  it('calls onToggleAccent with the clicked beat index', () => {
    const onToggle = vi.fn();
    render(
      <BeatStrip
        numerator={3}
        accents={[true, false, false]}
        activeBeat={-1}
        onToggleAccent={onToggle}
      />,
    );
    fireEvent.click(screen.getAllByRole('switch')[2]);
    expect(onToggle).toHaveBeenCalledWith(2);
  });
});
