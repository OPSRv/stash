import { describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { Textarea } from './Textarea';

describe('Textarea', () => {
  it('renders with default 3 rows', () => {
    const { container } = render(<Textarea placeholder="x" />);
    const ta = container.querySelector('textarea')!;
    expect(ta.rows).toBe(3);
  });

  it('respects custom rows', () => {
    const { container } = render(<Textarea placeholder="x" rows={6} />);
    expect(container.querySelector('textarea')!.rows).toBe(6);
  });

  it('fires onChange', () => {
    const onChange = vi.fn();
    render(<Textarea placeholder="ch" onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText('ch'), { target: { value: 'hi' } });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('applies danger border for invalid', () => {
    const { container } = render(<Textarea placeholder="d" invalid />);
    expect(container.querySelector('textarea')!.className).toContain('--color-danger-rgb');
  });

  it('forwards ref', () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<Textarea ref={ref} placeholder="r" />);
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
  });
});
