import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { RangeSlider } from './RangeSlider';

describe('RangeSlider', () => {
  it('renders with aria-label from label prop', () => {
    render(<RangeSlider value={50} onChange={vi.fn()} label="Volume" />);
    expect(screen.getByRole('slider', { name: 'Volume' })).toBeInTheDocument();
  });

  it('calls onChange with a numeric value', () => {
    const onChange = vi.fn();
    render(<RangeSlider value={50} onChange={onChange} label="v" />);
    fireEvent.change(screen.getByRole('slider'), { target: { value: '75' } });
    expect(onChange).toHaveBeenCalledWith(75);
    expect(typeof onChange.mock.calls[0]?.[0]).toBe('number');
  });

  it('applies the disabled attribute', () => {
    render(<RangeSlider value={50} onChange={vi.fn()} disabled label="v" />);
    expect(screen.getByRole('slider')).toBeDisabled();
  });

  it('uses default min/max/step', () => {
    render(<RangeSlider value={10} onChange={vi.fn()} label="v" />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('min', '0');
    expect(slider).toHaveAttribute('max', '100');
    expect(slider).toHaveAttribute('step', '1');
  });

  it('honours custom min/max/step for fractional ranges', () => {
    render(
      <RangeSlider value={0.5} onChange={vi.fn()} min={0} max={1} step={0.01} label="v" />,
    );
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('max', '1');
    expect(slider).toHaveAttribute('step', '0.01');
  });

  it('sets --stash-range-pct when showFill (default) and clamps out-of-range values', () => {
    const { rerender } = render(
      <RangeSlider value={-10} onChange={vi.fn()} min={0} max={100} label="v" />,
    );
    const slider = screen.getByRole('slider') as HTMLInputElement;
    expect(slider.style.getPropertyValue('--stash-range-pct')).toBe('0%');
    rerender(<RangeSlider value={200} onChange={vi.fn()} min={0} max={100} label="v" />);
    expect(slider.style.getPropertyValue('--stash-range-pct')).toBe('100%');
  });

  it('omits the fill var when showFill=false and adds the no-fill class', () => {
    render(
      <RangeSlider value={50} onChange={vi.fn()} showFill={false} label="v" />,
    );
    const slider = screen.getByRole('slider') as HTMLInputElement;
    expect(slider.style.getPropertyValue('--stash-range-pct')).toBe('');
    expect(slider).toHaveClass('stash-range--no-fill');
  });
});
