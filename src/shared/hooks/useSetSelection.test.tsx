import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSetSelection } from './useSetSelection';

describe('useSetSelection', () => {
  it('starts empty by default', () => {
    const { result } = renderHook(() => useSetSelection<string>());
    expect(result.current.size).toBe(0);
    expect(result.current.selected.size).toBe(0);
  });

  it('accepts an initial iterable', () => {
    const { result } = renderHook(() => useSetSelection(['a', 'b']));
    expect(result.current.size).toBe(2);
    expect(result.current.isSelected('a')).toBe(true);
    expect(result.current.isSelected('c')).toBe(false);
  });

  it('toggleOne adds and removes items', () => {
    const { result } = renderHook(() => useSetSelection<string>());
    act(() => result.current.toggleOne('a'));
    expect(result.current.isSelected('a')).toBe(true);
    act(() => result.current.toggleOne('a'));
    expect(result.current.isSelected('a')).toBe(false);
  });

  it('toggleAll selects all when size differs, clears when saturated', () => {
    const all = ['a', 'b', 'c'];
    const { result } = renderHook(() => useSetSelection<string>());
    act(() => result.current.toggleAll(all));
    expect(result.current.size).toBe(3);
    act(() => result.current.toggleAll(all));
    expect(result.current.size).toBe(0);
  });

  it('selectAll replaces the set with every key', () => {
    const { result } = renderHook(() => useSetSelection<string>(['a']));
    act(() => result.current.selectAll(['x', 'y']));
    expect(result.current.isSelected('a')).toBe(false);
    expect(result.current.isSelected('x')).toBe(true);
    expect(result.current.isSelected('y')).toBe(true);
  });

  it('clear drops everything', () => {
    const { result } = renderHook(() => useSetSelection(['a', 'b']));
    act(() => result.current.clear());
    expect(result.current.size).toBe(0);
  });
});
