import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Timeline } from './Timeline';
import type { Block } from './api';

const mk = (id: string, name: string, min: number, posture: Block['posture'] = 'sit'): Block => ({
  id,
  name,
  duration_sec: min * 60,
  posture,
  mid_nudge_sec: null,
});

describe('Timeline', () => {
  it('renders one block per item with posture + duration meta', () => {
    render(
      <Timeline
        mode="edit"
        blocks={[mk('a', 'Focus', 25, 'sit'), mk('b', 'Walk', 10, 'walk')]}
      />,
    );
    const focus = screen.getByTestId('pom-block-a');
    const walk = screen.getByTestId('pom-block-b');
    expect(focus).toHaveAttribute('data-posture', 'sit');
    expect(walk).toHaveAttribute('data-posture', 'walk');
    expect(focus.textContent).toContain('Focus');
    expect(focus.textContent).toContain('25m');
    expect(walk.textContent).toContain('10m');
  });

  it('cycles posture when clicking the posture button in edit mode', () => {
    const onChange = vi.fn();
    render(
      <Timeline
        mode="edit"
        blocks={[mk('a', 'Focus', 25, 'sit')]}
        onChange={onChange}
      />,
    );
    const button = screen.getByLabelText('Posture: sit');
    fireEvent.click(button);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0][0].posture).toBe('stand');
  });

  it('switches to inline rename on double-click and commits on Enter', () => {
    const onChange = vi.fn();
    render(
      <Timeline
        mode="edit"
        blocks={[mk('a', 'Focus', 25)]}
        onChange={onChange}
      />,
    );
    const block = screen.getByTestId('pom-block-a');
    fireEvent.doubleClick(block);
    const input = screen.getByLabelText('Block name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Deep work' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'a', name: 'Deep work' }),
    ]);
  });

  it('playing-mode marks current and past blocks via data-state', () => {
    render(
      <Timeline
        mode="playing"
        blocks={[mk('a', 'A', 5), mk('b', 'B', 5), mk('c', 'C', 5)]}
        currentIdx={1}
        progress={0.5}
      />,
    );
    expect(screen.getByTestId('pom-block-a')).toHaveAttribute('data-state', 'done');
    expect(screen.getByTestId('pom-block-b')).toHaveAttribute('data-state', 'current');
    expect(screen.getByTestId('pom-block-c')).toHaveAttribute('data-state', 'pending');
  });

  it('click in playing-mode calls onJumpTo with the block index', () => {
    const onJumpTo = vi.fn();
    render(
      <Timeline
        mode="playing"
        blocks={[mk('a', 'A', 5), mk('b', 'B', 5)]}
        currentIdx={0}
        progress={0}
        onJumpTo={onJumpTo}
      />,
    );
    fireEvent.click(screen.getByTestId('pom-block-b'));
    expect(onJumpTo).toHaveBeenCalledWith(1);
  });
});
