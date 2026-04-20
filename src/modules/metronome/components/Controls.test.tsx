import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Controls } from './Controls';
import { DEFAULT_STATE } from '../metronome.constants';

describe('Controls', () => {
  it('increments the numerator via the stepper', () => {
    const onPatch = vi.fn();
    render(<Controls state={DEFAULT_STATE} onPatch={onPatch} />);
    fireEvent.click(screen.getByRole('button', { name: 'Increase numerator' }));
    expect(onPatch).toHaveBeenCalledWith({ numerator: 5 });
  });

  it('decrements the numerator but clamps at the minimum', () => {
    const onPatch = vi.fn();
    render(<Controls state={{ ...DEFAULT_STATE, numerator: 1, beat_accents: [true] }} onPatch={onPatch} />);
    expect(screen.getByRole('button', { name: 'Decrease numerator' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Increase numerator' }));
    expect(onPatch).toHaveBeenCalledWith({ numerator: 2 });
  });

  it('emits a denominator patch when a denominator is chosen', () => {
    const onPatch = vi.fn();
    render(<Controls state={DEFAULT_STATE} onPatch={onPatch} />);
    fireEvent.click(screen.getByRole('radio', { name: '8' }));
    expect(onPatch).toHaveBeenCalledWith({ denominator: 8 });
  });

  it('emits a subdivision patch when an subdivision button is chosen', () => {
    const onPatch = vi.fn();
    render(<Controls state={DEFAULT_STATE} onPatch={onPatch} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Triplets' }));
    expect(onPatch).toHaveBeenCalledWith({ subdivision: 3 });
  });

  it('emits a click_volume patch when the click slider moves', () => {
    const onPatch = vi.fn();
    render(<Controls state={DEFAULT_STATE} onPatch={onPatch} />);
    const slider = screen.getByTestId('vol-click') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '50' } });
    expect(onPatch).toHaveBeenCalledWith({ click_volume: 0.5 });
  });
});
