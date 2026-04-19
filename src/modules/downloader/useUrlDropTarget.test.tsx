import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DragEvent } from 'react';
import { useUrlDropTarget } from './useUrlDropTarget';

const makeDragEvent = (data: Record<string, string>): DragEvent => {
  const dt = {
    getData: (k: string) => data[k] ?? '',
  } as unknown as DataTransfer;
  return {
    preventDefault: vi.fn(),
    dataTransfer: dt,
  } as unknown as DragEvent;
};

describe('useUrlDropTarget', () => {
  it('flips isDragOver on dragOver and off on dragLeave', () => {
    const { result } = renderHook(() => useUrlDropTarget(() => {}));
    expect(result.current.isDragOver).toBe(false);
    act(() => result.current.handlers.onDragOver(makeDragEvent({})));
    expect(result.current.isDragOver).toBe(true);
    act(() => result.current.handlers.onDragLeave());
    expect(result.current.isDragOver).toBe(false);
  });

  it('prefers text/uri-list over text/plain', () => {
    const dropped = vi.fn();
    const { result } = renderHook(() => useUrlDropTarget(dropped));
    act(() =>
      result.current.handlers.onDrop(
        makeDragEvent({
          'text/uri-list': 'https://uri-list.example/',
          'text/plain': 'https://plain.example/',
        })
      )
    );
    expect(dropped).toHaveBeenCalledWith('https://uri-list.example/');
  });

  it('falls back to text/plain when uri-list is empty', () => {
    const dropped = vi.fn();
    const { result } = renderHook(() => useUrlDropTarget(dropped));
    act(() =>
      result.current.handlers.onDrop(
        makeDragEvent({ 'text/plain': 'https://plain.example/' })
      )
    );
    expect(dropped).toHaveBeenCalledWith('https://plain.example/');
  });

  it('trims whitespace and skips empty drops', () => {
    const dropped = vi.fn();
    const { result } = renderHook(() => useUrlDropTarget(dropped));
    act(() =>
      result.current.handlers.onDrop(
        makeDragEvent({ 'text/plain': '   \n  ' })
      )
    );
    expect(dropped).not.toHaveBeenCalled();
    act(() =>
      result.current.handlers.onDrop(
        makeDragEvent({ 'text/plain': '   https://x.com/a  ' })
      )
    );
    expect(dropped).toHaveBeenCalledWith('https://x.com/a');
  });

  it('resets isDragOver on drop and calls preventDefault', () => {
    const { result } = renderHook(() => useUrlDropTarget(() => {}));
    act(() => result.current.handlers.onDragOver(makeDragEvent({})));
    expect(result.current.isDragOver).toBe(true);
    const ev = makeDragEvent({ 'text/plain': 'https://x.com/a' });
    act(() => result.current.handlers.onDrop(ev));
    expect(result.current.isDragOver).toBe(false);
    expect(ev.preventDefault).toHaveBeenCalled();
  });
});
