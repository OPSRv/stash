import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { useSuppressibleConfirm } from './useSuppressibleConfirm';

// jsdom's localStorage under node 25 occasionally lacks methods. Install a
// simple in-memory Storage polyfill for this test suite so the hook's
// persistence branch is exercised deterministically.
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(k: string) {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

const KEY = 'stash.confirm.suppress.test.key';
let mem: MemoryStorage;

describe('useSuppressibleConfirm', () => {
  beforeEach(() => {
    mem = new MemoryStorage();
    vi.stubGlobal('localStorage', mem);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens on first request', () => {
    const { result } = renderHook(() => useSuppressibleConfirm<number>('test.key'));
    const run = vi.fn();
    act(() => result.current.request(42, run));
    expect(result.current.open).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs immediately when suppressed', () => {
    mem.setItem(KEY, '1');
    const { result } = renderHook(() => useSuppressibleConfirm<number>('test.key'));
    const run = vi.fn();
    act(() => result.current.request(7, run));
    expect(result.current.open).toBe(false);
    expect(run).toHaveBeenCalledWith(7);
  });

  it('confirm(false) runs action without persisting suppression', () => {
    const { result } = renderHook(() => useSuppressibleConfirm<string>('test.key'));
    const run = vi.fn();
    act(() => result.current.request('x', run));
    act(() => result.current.confirm(false));
    expect(run).toHaveBeenCalledWith('x');
    expect(mem.getItem(KEY)).toBeNull();
    expect(result.current.open).toBe(false);
  });

  it('confirm(true) persists suppression', () => {
    const { result } = renderHook(() => useSuppressibleConfirm<string>('test.key'));
    const run = vi.fn();
    act(() => result.current.request('y', run));
    act(() => result.current.confirm(true));
    expect(mem.getItem(KEY)).toBe('1');
    expect(result.current.suppressed).toBe(true);
  });

  it('cancel closes without running', () => {
    const { result } = renderHook(() => useSuppressibleConfirm<number>('test.key'));
    const run = vi.fn();
    act(() => result.current.request(1, run));
    act(() => result.current.cancel());
    expect(run).not.toHaveBeenCalled();
    expect(result.current.open).toBe(false);
  });

  it('reset clears suppression', () => {
    mem.setItem(KEY, '1');
    const { result } = renderHook(() => useSuppressibleConfirm<number>('test.key'));
    act(() => result.current.reset());
    expect(mem.getItem(KEY)).toBeNull();
    expect(result.current.suppressed).toBe(false);
  });
});
