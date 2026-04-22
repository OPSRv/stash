import { describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { Input } from './Input';

describe('Input', () => {
  it('renders bare input when no decorations', () => {
    const { container } = render(<Input placeholder="bare" />);
    expect(container.firstChild?.nodeName).toBe('INPUT');
  });

  it('wraps in div when leadingIcon is set', () => {
    const { container } = render(
      <Input placeholder="x" leadingIcon={<span data-testid="lead" />} />,
    );
    expect(container.firstChild?.nodeName).toBe('DIV');
    expect(screen.getByTestId('lead')).toBeInTheDocument();
  });

  it('renders trailing slot', () => {
    render(<Input placeholder="x" trailing={<span data-testid="trail" />} />);
    expect(screen.getByTestId('trail')).toBeInTheDocument();
  });

  it('fires onChange', () => {
    const onChange = vi.fn();
    render(<Input placeholder="ch" onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText('ch'), { target: { value: 'hi' } });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('applies danger border for tone=danger', () => {
    const { container } = render(<Input placeholder="d" tone="danger" />);
    expect((container.firstChild as HTMLElement).className).toContain('--color-danger-rgb');
  });

  it('applies disabled styling', () => {
    const { container } = render(<Input placeholder="d" disabled />);
    expect((container.firstChild as HTMLInputElement).disabled).toBe(true);
    expect((container.firstChild as HTMLElement).className).toContain('opacity-40');
  });

  it('forwards ref', () => {
    const ref = createRef<HTMLInputElement>();
    render(<Input ref={ref} placeholder="r" />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });

  it('has focus-visible ring utility class (bare input)', () => {
    const { container } = render(<Input placeholder="r" />);
    expect((container.firstChild as HTMLElement).className).toContain('ring-focus');
  });

  it('has focus-within ring on wrapper when decorated', () => {
    const { container } = render(
      <Input placeholder="r" leadingIcon={<span data-testid="l" />} />,
    );
    expect((container.firstChild as HTMLElement).className).toContain('ring-focus-within');
  });
});
