import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { useHistorySearch } from './useHistorySearch';
import type { TranslationRow } from './api';

const mockInvoke = vi.mocked(invoke);

const row = (id: number, original = 'o'): TranslationRow => ({
  id,
  original,
  translated: 't',
  from_lang: 'uk',
  to_lang: 'en',
  created_at: 0,
});

beforeEach(() => {
  mockInvoke.mockReset();
});

describe('useHistorySearch', () => {
  it('loads full list for empty query', async () => {
    mockInvoke.mockResolvedValueOnce([row(1)]);
    const onResults = vi.fn();
    renderHook(() => useHistorySearch({ query: '', reloadKey: 0, onResults }));
    await waitFor(() => expect(onResults).toHaveBeenCalled());
    expect(mockInvoke).toHaveBeenCalledWith('translator_list', expect.anything());
    expect(onResults).toHaveBeenCalledWith([row(1)]);
  });

  it('re-fetches when reloadKey changes even if query unchanged', async () => {
    mockInvoke.mockResolvedValue([]);
    const onResults = vi.fn();
    const { rerender } = renderHook(
      ({ reloadKey }) => useHistorySearch({ query: '', reloadKey, onResults }),
      { initialProps: { reloadKey: 0 } },
    );
    await waitFor(() => expect(onResults).toHaveBeenCalledTimes(1));
    rerender({ reloadKey: 1 });
    await waitFor(() => expect(onResults).toHaveBeenCalledTimes(2));
  });

  it('ignores stale responses when a newer query supersedes them', async () => {
    // First call ("h") resolves slowly, second call ("hel") resolves fast.
    let resolveFirst!: (rows: TranslationRow[]) => void;
    const slow = new Promise<TranslationRow[]>((res) => {
      resolveFirst = res;
    });
    mockInvoke
      .mockImplementationOnce(() => slow)
      .mockImplementationOnce(() => Promise.resolve([row(2, 'fresh')]));

    const onResults = vi.fn();
    const { rerender } = renderHook(
      ({ query }) => useHistorySearch({ query, reloadKey: 0, onResults }),
      { initialProps: { query: 'h' } },
    );
    // Let the first debounced IPC actually start.
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));
    rerender({ query: 'hel' });

    await waitFor(() => {
      expect(onResults).toHaveBeenCalledWith([row(2, 'fresh')]);
    });

    // Now resolve the stale first call — it must NOT call onResults.
    const callsBeforeStale = onResults.mock.calls.length;
    resolveFirst([row(1, 'stale')]);
    await Promise.resolve();
    await Promise.resolve();
    expect(onResults).toHaveBeenCalledTimes(callsBeforeStale);
  });
});
