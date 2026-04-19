import { describe, expect, it } from 'vitest';
import { useRef } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { useFocusTrap } from './useFocusTrap';

const Harness = ({ active }: { active: boolean }) => {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, active);
  return (
    <div ref={ref} data-testid="trap">
      <button>a</button>
      <button>b</button>
      <button>c</button>
    </div>
  );
};

describe('useFocusTrap', () => {
  it('focuses first tabbable on activation', () => {
    render(<Harness active />);
    expect(document.activeElement?.textContent).toBe('a');
  });

  it('Tab from last wraps to first', () => {
    const { getByText, getByTestId } = render(<Harness active />);
    (getByText('c') as HTMLButtonElement).focus();
    fireEvent.keyDown(getByTestId('trap'), { key: 'Tab' });
    expect(document.activeElement?.textContent).toBe('a');
  });

  it('Shift-Tab from first wraps to last', () => {
    const { getByText, getByTestId } = render(<Harness active />);
    (getByText('a') as HTMLButtonElement).focus();
    fireEvent.keyDown(getByTestId('trap'), { key: 'Tab', shiftKey: true });
    expect(document.activeElement?.textContent).toBe('c');
  });

  it('does nothing when inactive', () => {
    const before = document.activeElement;
    render(<Harness active={false} />);
    expect(document.activeElement).toBe(before);
  });
});
