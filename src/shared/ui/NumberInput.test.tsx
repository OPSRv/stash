import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { NumberInput } from './NumberInput';

const Controlled = ({
  initial = 5,
  ...rest
}: {
  initial?: number | null;
} & Omit<React.ComponentProps<typeof NumberInput>, 'value' | 'onChange'> & {
  onCommit?: (v: number | null) => void;
}) => {
  const [v, setV] = useState<number | null>(initial);
  return (
    <NumberInput
      {...rest}
      value={v}
      onChange={(n) => {
        setV(n);
        rest.onCommit?.(n);
      }}
    />
  );
};

describe('NumberInput', () => {
  it('renders a spinbutton with aria value attributes', () => {
    render(<Controlled ariaLabel="pad" min={0} max={10} initial={3} />);
    const input = screen.getByRole('spinbutton', { name: 'pad' });
    expect(input).toHaveAttribute('aria-valuenow', '3');
    expect(input).toHaveAttribute('aria-valuemin', '0');
    expect(input).toHaveAttribute('aria-valuemax', '10');
  });

  it('commits the typed value on blur, clamping to max', () => {
    const onCommit = vi.fn();
    render(<Controlled ariaLabel="x" max={10} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenLastCalledWith(10);
  });

  it('commits null for empty input', () => {
    const onCommit = vi.fn();
    render(<Controlled ariaLabel="x" onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenLastCalledWith(null);
  });

  it('increments via the ▲ button by `step`', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Controlled ariaLabel="x" step={2} initial={4} onCommit={onCommit} />);
    await user.click(screen.getByRole('button', { name: 'Increment' }));
    expect(onCommit).toHaveBeenLastCalledWith(6);
  });

  it('ArrowUp nudges by step; Shift+ArrowUp by 10×', () => {
    const onCommit = vi.fn();
    render(<Controlled ariaLabel="x" step={1} initial={3} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(onCommit).toHaveBeenLastCalledWith(4);
    fireEvent.keyDown(input, { key: 'ArrowUp', shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(14);
  });

  it('respects max on Increment', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Controlled ariaLabel="x" max={5} initial={5} onCommit={onCommit} />);
    const incBtn = screen.getByRole('button', { name: 'Increment' });
    expect(incBtn).toBeDisabled();
    await user.click(incBtn);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('marks the field invalid while the draft does not parse', () => {
    render(<Controlled ariaLabel="x" initial={5} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(input, { target: { value: '7' } });
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('rounds to `precision` fraction digits on commit', () => {
    const onCommit = vi.fn();
    render(<Controlled ariaLabel="x" step={0.1} initial={0.1} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1.2345' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenLastCalledWith(1.2);
  });
});
