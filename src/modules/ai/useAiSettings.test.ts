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

  test('reads provider/model from the store', async () => {
    vi.mocked(loadSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      aiProvider: 'anthropic',
      aiModel: 'claude-opus-4-7',
    });
    const { result } = renderHook(() => useAiSettings());
    await waitFor(() => {
      expect(result.current.aiProvider).toBe('anthropic');
      expect(result.current.aiModel).toBe('claude-opus-4-7');
    });
  });

  test('re-reads on stash:settings-changed event', async () => {
    vi.mocked(loadSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      aiProvider: 'openai',
    });
    const { result } = renderHook(() => useAiSettings());
    await waitFor(() => expect(result.current.aiProvider).toBe('openai'));

    vi.mocked(loadSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      aiProvider: 'google',
      aiModel: 'gemini-2.5-pro',
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent('stash:settings-changed'));
    });
    await waitFor(() => {
      expect(result.current.aiProvider).toBe('google');
      expect(result.current.aiModel).toBe('gemini-2.5-pro');
    });
  });
});
