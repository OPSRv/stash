import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useKeyboardNav } from './useKeyboardNav';

const fireKey = (key: string) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  window.dispatchEvent(event);
};

describe('useKeyboardNav', () => {
  it('starts with index 0', () => {
    const { result } = renderHook(() => useKeyboardNav({ itemCount: 3 }));
    expect(result.current.index).toBe(0);
  });

  it('ArrowDown increments index', () => {
    const { result } = renderHook(() => useKeyboardNav({ itemCount: 3 }));
    act(() => fireKey('ArrowDown'));
    expect(result.current.index).toBe(1);
  });

  it('ArrowUp decrements index', () => {
    const { result } = renderHook(() => useKeyboardNav({ itemCount: 3 }));
    act(() => fireKey('ArrowDown'));
    act(() => fireKey('ArrowDown'));
    act(() => fireKey('ArrowUp'));
    expect(result.current.index).toBe(1);
  });

  it('clamps at 0 when pressing ArrowUp at top', () => {
    const { result } = renderHook(() => useKeyboardNav({ itemCount: 3 }));
    act(() => fireKey('ArrowUp'));
    expect(result.current.index).toBe(0);
  });

  it('clamps at last index when pressing ArrowDown at bottom', () => {
    const { result } = renderHook(() => useKeyboardNav({ itemCount: 3 }));
    act(() => fireKey('ArrowDown'));
    act(() => fireKey('ArrowDown'));
    act(() => fireKey('ArrowDown'));
    act(() => fireKey('ArrowDown'));
    expect(result.current.index).toBe(2);
  });

  it('Enter calls onSelect with current index', () => {
    const onSelect = vi.fn();
    renderHook(() => useKeyboardNav({ itemCount: 3, onSelect }));
    act(() => fireKey('ArrowDown'));
    act(() => fireKey('Enter'));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('resets index when itemCount shrinks below it', () => {
    const { result, rerender } = renderHook(
      ({ count }) => useKeyboardNav({ itemCount: count }),
      { initialProps: { count: 5 } }
    );
    act(() => fireKey('ArrowDown'));
    act(() => fireKey('ArrowDown'));
    act(() => fireKey('ArrowDown'));
    expect(result.current.index).toBe(3);
    rerender({ count: 2 });
    expect(result.current.index).toBe(1);
  });
});
