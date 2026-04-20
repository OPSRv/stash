import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ExtrasRow } from './ExtrasRow';
import { DEFAULT_STATE, type Preset } from '../metronome.constants';

const withPresets = (presets: Preset[]) => ({ ...DEFAULT_STATE, presets });

describe('ExtrasRow — trainer', () => {
  it('toggles trainer on', () => {
    const onPatch = vi.fn();
    render(<ExtrasRow state={DEFAULT_STATE} onPatch={onPatch} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Trainer mode' }));
    expect(onPatch).toHaveBeenCalledWith({
      trainer: { ...DEFAULT_STATE.trainer, enabled: true },
    });
  });

  it('bumps trainer step via its stepper', () => {
    const state = { ...DEFAULT_STATE, trainer: { ...DEFAULT_STATE.trainer, enabled: true } };
    const onPatch = vi.fn();
    render(<ExtrasRow state={state} onPatch={onPatch} />);
    fireEvent.click(within(screen.getByTestId('trainer-step')).getByLabelText('Increase Step'));
    expect(onPatch).toHaveBeenCalledWith({
      trainer: { ...state.trainer, step_bpm: state.trainer.step_bpm + 1 },
    });
  });

  it('decrements bars and clamps at the minimum', () => {
    const state = {
      ...DEFAULT_STATE,
      trainer: { ...DEFAULT_STATE.trainer, enabled: true, every_bars: 1 },
    };
    render(<ExtrasRow state={state} onPatch={vi.fn()} />);
    expect(
      within(screen.getByTestId('trainer-bars')).getByLabelText('Decrease Every'),
    ).toBeDisabled();
  });

  it('adjusts target bpm with the wheel', () => {
    const state = { ...DEFAULT_STATE, trainer: { ...DEFAULT_STATE.trainer, enabled: true } };
    const onPatch = vi.fn();
    render(<ExtrasRow state={state} onPatch={onPatch} />);
    fireEvent.wheel(screen.getByTestId('trainer-target'), { deltaY: -10 });
    expect(onPatch).toHaveBeenCalledWith({
      trainer: { ...state.trainer, target_bpm: state.trainer.target_bpm + 1 },
    });
  });
});

describe('ExtrasRow — presets', () => {
  it('saves the current settings as a new preset', () => {
    const onPatch = vi.fn();
    render(<ExtrasRow state={DEFAULT_STATE} onPatch={onPatch} />);
    fireEvent.click(screen.getByTestId('preset-save'));
    expect(onPatch).toHaveBeenCalledTimes(1);
    const arg = onPatch.mock.calls[0][0];
    expect(arg.presets).toHaveLength(1);
    expect(arg.presets[0]).toMatchObject({
      bpm: DEFAULT_STATE.bpm,
      numerator: DEFAULT_STATE.numerator,
      denominator: DEFAULT_STATE.denominator,
      subdivision: DEFAULT_STATE.subdivision,
      sound: DEFAULT_STATE.sound,
      beat_accents: DEFAULT_STATE.beat_accents,
    });
    expect(arg.presets[0].id).toMatch(/^p_/);
    expect(arg.presets[0].name).toContain('4/4');
  });

  it('applies a preset when its chip is clicked', () => {
    const preset: Preset = {
      id: 'x1',
      name: '180 · 5/4',
      bpm: 180,
      numerator: 5,
      denominator: 4,
      subdivision: 2,
      sound: 'wood',
      beat_accents: [true, false, false, false, false],
    };
    const onPatch = vi.fn();
    render(<ExtrasRow state={withPresets([preset])} onPatch={onPatch} />);
    fireEvent.click(screen.getByTestId('preset-chip-x1'));
    expect(onPatch).toHaveBeenCalledWith({
      bpm: 180,
      numerator: 5,
      denominator: 4,
      subdivision: 2,
      sound: 'wood',
      beat_accents: [true, false, false, false, false],
    });
  });

  it('deletes a preset from its own chip', () => {
    const a: Preset = {
      id: 'a',
      name: 'A',
      bpm: 100,
      numerator: 4,
      denominator: 4,
      subdivision: 1,
      sound: 'click',
      beat_accents: [true, false, false, false],
    };
    const b: Preset = { ...a, id: 'b', name: 'B' };
    const onPatch = vi.fn();
    render(<ExtrasRow state={withPresets([a, b])} onPatch={onPatch} />);
    fireEvent.click(screen.getByTestId('preset-delete-a'));
    expect(onPatch).toHaveBeenCalledWith({ presets: [b] });
  });

  it('shows an empty-state hint when no presets are saved', () => {
    render(<ExtrasRow state={DEFAULT_STATE} onPatch={vi.fn()} />);
    expect(screen.getByText('No presets yet')).toBeInTheDocument();
  });
});
