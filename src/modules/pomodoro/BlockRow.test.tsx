import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { BlockRow } from './BlockRow';
import type { Block } from './api';

const mk = (over: Partial<Block> = {}): Block => ({
  id: 'a',
  name: 'Focus',
  duration_sec: 1500,
  posture: 'sit',
  mid_nudge_sec: null,
  ...over,
});

describe('BlockRow', () => {
  it('emits onChange with new name when user types', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<BlockRow block={mk()} onChange={onChange} onDelete={() => {}} />);
    const name = screen.getByLabelText('Block name');
    await user.type(name, 'X');
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'FocusX' }),
    );
  });

  it('emits onChange with new duration_sec when minutes change', () => {
    const onChange = vi.fn();
    render(<BlockRow block={mk({ duration_sec: 1500 })} onChange={onChange} onDelete={() => {}} />);
    const dur = screen.getByLabelText('Duration in minutes') as HTMLInputElement;
    fireEvent.change(dur, { target: { value: '10' } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ duration_sec: 600 }),
    );
  });

  it('emits onChange with new posture when segment is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<BlockRow block={mk()} onChange={onChange} onDelete={() => {}} />);
    await user.click(screen.getByRole('radio', { name: /walk/i }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ posture: 'walk' }),
    );
  });

  it('toggles mid_nudge_sec on/off', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<BlockRow block={mk()} onChange={onChange} onDelete={() => {}} />);
    await user.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ mid_nudge_sec: expect.any(Number) }),
    );
  });

  it('delete button calls onDelete', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<BlockRow block={mk()} onChange={() => {}} onDelete={onDelete} />);
    await user.click(screen.getByRole('button', { name: /remove block/i }));
    expect(onDelete).toHaveBeenCalled();
  });

  it('readOnly mode shows duration + posture without inputs', () => {
    render(<BlockRow block={mk()} onChange={() => {}} onDelete={() => {}} readOnly />);
    expect(screen.queryByLabelText('Block name')).not.toBeInTheDocument();
    expect(screen.getByText('Focus')).toBeInTheDocument();
    expect(screen.getByText('25m')).toBeInTheDocument();
  });
});
