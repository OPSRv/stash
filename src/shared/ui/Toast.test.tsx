import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './Toast';

const Trigger = ({ props }: { props: Parameters<ReturnType<typeof useToast>['toast']>[0] }) => {
  const { toast } = useToast();
  return <button onClick={() => toast(props)}>fire</button>;
};

describe('Toast', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders toast title', () => {
    render(
      <ToastProvider>
        <Trigger props={{ title: 'Saved' }} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('fire'));
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('auto-dismisses after duration', () => {
    render(
      <ToastProvider>
        <Trigger props={{ title: 'Saved' }} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('fire'));
    expect(screen.getByText('Saved')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4600);
    });
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('error variant uses role=alert and longer duration', () => {
    render(
      <ToastProvider>
        <Trigger props={{ title: 'Failed', variant: 'error' }} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('fire'));
    expect(screen.getByRole('alert').textContent).toContain('Failed');
    act(() => {
      vi.advanceTimersByTime(4600);
    });
    expect(screen.queryByText('Failed')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
  });

  it('action fires callback and dismisses', () => {
    const onClick = vi.fn();
    render(
      <ToastProvider>
        <Trigger
          props={{
            title: 'Failed',
            variant: 'error',
            action: { label: 'Retry', onClick },
          }}
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('fire'));
    fireEvent.click(screen.getByText('Retry'));
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
  });

  it('cancels the auto-dismiss timer of toasts evicted by the MAX_VISIBLE cap', () => {
    const clearSpy = vi.spyOn(window, 'clearTimeout');
    render(
      <ToastProvider>
        <Trigger props={{ title: 'T' }} />
      </ToastProvider>,
    );
    // Fire 4 toasts (MAX_VISIBLE = 3) — the oldest is evicted on the 4th.
    fireEvent.click(screen.getByText('fire'));
    fireEvent.click(screen.getByText('fire'));
    fireEvent.click(screen.getByText('fire'));
    const clearsBeforeEvict = clearSpy.mock.calls.length;
    fireEvent.click(screen.getByText('fire'));
    // Evicting the first toast must clear its scheduled dismiss timer.
    expect(clearSpy.mock.calls.length).toBeGreaterThan(clearsBeforeEvict);
    clearSpy.mockRestore();
  });

  it('dismiss button removes the toast', () => {
    render(
      <ToastProvider>
        <Trigger props={{ title: 'Saved' }} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('fire'));
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });
});
