import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Controls } from './Controls';
import { DEFAULT_STATE } from '../metronome.constants';

describe('Controls', () => {
  it('emits a numerator/denominator patch when a time signature is chosen', () => {
    const onPatch = vi.fn();
    render(<Controls state={DEFAULT_STATE} onPatch={onPatch} />);
    fireEvent.click(screen.getByRole('radio', { name: '3/4' }));
    expect(onPatch).toHaveBeenCalledWith({ numerator: 3, denominator: 4 });
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
