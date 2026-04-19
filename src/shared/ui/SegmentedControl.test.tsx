import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SegmentedControl } from './SegmentedControl';

const opts = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
] as const;

describe('SegmentedControl', () => {
  it('renders all options', () => {
    render(<SegmentedControl options={opts} value="a" onChange={() => {}} />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('marks active option with aria-checked', () => {
    render(<SegmentedControl options={opts} value="b" onChange={() => {}} />);
    const radios = screen.getAllByRole('radio');
    expect(radios[0].getAttribute('aria-checked')).toBe('false');
    expect(radios[1].getAttribute('aria-checked')).toBe('true');
    expect(radios[1].className).toContain('on');
  });

  it('calls onChange with value', () => {
    const onChange = vi.fn();
    render(<SegmentedControl options={opts} value="a" onChange={onChange} />);
    fireEvent.click(screen.getByText('Beta'));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('container has radiogroup role', () => {
    render(<SegmentedControl options={opts} value="a" onChange={() => {}} ariaLabel="modes" />);
    expect(screen.getByRole('radiogroup', { name: 'modes' })).toBeInTheDocument();
  });
});
