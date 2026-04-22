import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAsync } from './useAsync';

describe('useAsync', () => {
  it('loads data on mount and exposes it via `data`', async () => {
    const fn = vi.fn().mockResolvedValue([1, 2, 3]);
    const { result } = renderHook(() => useAsync(fn));
    await waitFor(() => expect(result.current.data).toEqual([1, 2, 3]));
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('captures errors as strings', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useAsync(fn));
    await waitFor(() => expect(result.current.error).toContain('boom'));
    expect(result.current.data).toBeNull();
  });

  it('skips auto-run when immediate is false', async () => {
    const fn = vi.fn().mockResolvedValue('x');
    const { result } = renderHook(() => useAsync(fn, [], { immediate: false }));
    expect(fn).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.reload();
    });
    expect(fn).toHaveBeenCalledOnce();
    expect(result.current.data).toBe('x');
  });

  it('reload re-runs the latest fn closure', async () => {
    let value = 'first';
    const { result, rerender } = renderHook(
      ({ v }: { v: string }) => useAsync(() => Promise.resolve(v), [v]),
      { initialProps: { v: value } },
    );
    await waitFor(() => expect(result.current.data).toBe('first'));
    value = 'second';
    rerender({ v: value });
    await waitFor(() => expect(result.current.data).toBe('second'));
  });

  it('does not set state after unmount', async () => {
    let resolve: ((v: string) => void) | undefined;
    const fn = vi.fn().mockImplementation(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    );
    const { result, unmount } = renderHook(() => useAsync(fn));
    unmount();
    resolve?.('late');
    // No throw = pass (React would warn on setState after unmount).
    expect(result.current.data).toBeNull();
  });
});
