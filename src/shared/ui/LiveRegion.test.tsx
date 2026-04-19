import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { LiveRegionProvider, useAnnounce } from './LiveRegion';

const Trigger = ({
  message,
  politeness,
}: {
  message: string;
  politeness?: 'polite' | 'assertive';
}) => {
  const { announce } = useAnnounce();
  return <button onClick={() => announce(message, politeness)}>go</button>;
};

describe('LiveRegion', () => {
  it('announces to polite region by default', () => {
    vi.useFakeTimers();
    render(
      <LiveRegionProvider>
        <Trigger message="hello" />
      </LiveRegionProvider>,
    );
    screen.getByText('go').click();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByTestId('live-region-polite').textContent).toBe('hello');
    vi.useRealTimers();
  });

  it('routes assertive messages to assertive region', () => {
    vi.useFakeTimers();
    render(
      <LiveRegionProvider>
        <Trigger message="urgent" politeness="assertive" />
      </LiveRegionProvider>,
    );
    screen.getByText('go').click();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByTestId('live-region-assertive').textContent).toBe('urgent');
    expect(screen.getByTestId('live-region-polite').textContent).toBe('');
    vi.useRealTimers();
  });

  it('exposes no-op announce when provider is missing', () => {
    render(<Trigger message="x" />);
    expect(() => screen.getByText('go').click()).not.toThrow();
  });
});
