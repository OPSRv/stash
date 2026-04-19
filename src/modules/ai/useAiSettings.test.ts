import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../settings/store', async () => {
  const actual = await vi.importActual<typeof import('../../settings/store')>(
    '../../settings/store',
  );
  return {
    ...actual,
    loadSettings: vi.fn(),
  };
});

import { DEFAULT_SETTINGS, loadSettings } from '../../settings/store';
import { useAiSettings } from './useAiSettings';

describe('useAiSettings', () => {
  beforeEach(() => {
    vi.mocked(loadSettings).mockReset();
  });

  test('returns defaults immediately, then reads from store', async () => {
    vi.mocked(loadSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      aiEnabled: true,
      aiProvider: 'anthropic',
      aiModel: 'claude-opus-4-7',
    });
    const { result } = renderHook(() => useAiSettings());
    expect(result.current.aiEnabled).toBe(false); // default, before promise
    await waitFor(() => {
      expect(result.current.aiEnabled).toBe(true);
      expect(result.current.aiProvider).toBe('anthropic');
      expect(result.current.aiModel).toBe('claude-opus-4-7');
    });
  });

  test('re-reads on stash:settings-changed event', async () => {
    vi.mocked(loadSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      aiEnabled: false,
    });
    const { result } = renderHook(() => useAiSettings());
    await waitFor(() => expect(result.current.aiEnabled).toBe(false));

    vi.mocked(loadSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      aiEnabled: true,
      aiProvider: 'google',
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent('stash:settings-changed'));
    });
    await waitFor(() => {
      expect(result.current.aiEnabled).toBe(true);
      expect(result.current.aiProvider).toBe('google');
    });
  });
});
