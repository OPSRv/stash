import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useAutoTranslate } from './useAutoTranslate';

describe('useAutoTranslate', () => {
  it('skips redundant round-trip for the same (text, to) pair', async () => {
    const onTranslate = vi.fn();
    const onEmpty = vi.fn();
    const { rerender } = renderHook(
      ({ draft, target }) =>
        useAutoTranslate({ draft, target, sourceHint: null, onTranslate, onEmpty }),
      { initialProps: { draft: 'hello', target: 'uk' } },
    );
    await waitFor(() => expect(onTranslate).toHaveBeenCalledTimes(1));
    // re-render with identical inputs: dedupe keeps the call count at 1.
    rerender({ draft: 'hello', target: 'uk' });
    await new Promise((r) => setTimeout(r, 500));
    expect(onTranslate).toHaveBeenCalledTimes(1);
  });

  it('reset() invalidates the dedupe cache so a later effect re-runs for the same (text, to) pair', async () => {
    const onTranslate = vi.fn();
    const onEmpty = vi.fn();
    const { result, rerender } = renderHook(
      ({ draft, target, sourceHint }) =>
        useAutoTranslate({ draft, target, sourceHint, onTranslate, onEmpty }),
      { initialProps: { draft: 'hello', target: 'uk', sourceHint: null as string | null } },
    );
    await waitFor(() => expect(onTranslate).toHaveBeenCalledTimes(1));

    // Trigger the effect via a non-text dep change; dedupe should still skip.
    rerender({ draft: 'hello', target: 'uk', sourceHint: 'en' });
    await new Promise((r) => setTimeout(r, 500));
    expect(onTranslate).toHaveBeenCalledTimes(1);

    act(() => result.current.reset());
    rerender({ draft: 'hello', target: 'uk', sourceHint: null });
    await waitFor(() => expect(onTranslate).toHaveBeenCalledTimes(2));
  });
});
