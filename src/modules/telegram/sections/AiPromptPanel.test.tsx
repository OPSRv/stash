import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiPromptPanel } from './AiPromptPanel';

const invokeMock = vi.mocked(invoke);

describe('AiPromptPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    invokeMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pre-fills the form from telegram_get_ai_settings', async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === 'telegram_get_ai_settings') {
        return { system_prompt: 'be snarky', context_window: 60 };
      }
      return null;
    });
    render(<AiPromptPanel />);
    await screen.findByDisplayValue('be snarky');
    expect(screen.getByText(/60 msg/)).toBeInTheDocument();
  });

  it('debounces writes through telegram_set_ai_settings', async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === 'telegram_get_ai_settings') {
        return { system_prompt: 'x', context_window: 50 };
      }
      return null;
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<AiPromptPanel />);
    const textarea = await screen.findByLabelText('System prompt');
    await user.clear(textarea);
    await user.type(textarea, 'hi');

    // Not yet debounced.
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === 'telegram_set_ai_settings'),
    ).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    await waitFor(() => {
      const saves = invokeMock.mock.calls.filter(
        (c) => c[0] === 'telegram_set_ai_settings',
      );
      expect(saves.length).toBeGreaterThan(0);
      // Latest save carries the final text.
      expect(
        (saves[saves.length - 1][1] as { settings: { system_prompt: string } }).settings
          .system_prompt,
      ).toBe('hi');
    });
  });

  it('Reset button rewrites to the default prompt', async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === 'telegram_get_ai_settings') {
        return { system_prompt: 'custom', context_window: 50 };
      }
      return null;
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<AiPromptPanel />);
    await screen.findByDisplayValue('custom');
    await user.click(screen.getByRole('button', { name: /Reset to default/ }));
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    await waitFor(() => {
      const saves = invokeMock.mock.calls.filter(
        (c) => c[0] === 'telegram_set_ai_settings',
      );
      expect(saves.length).toBeGreaterThan(0);
      const last = saves[saves.length - 1][1] as {
        settings: { system_prompt: string };
      };
      expect(last.settings.system_prompt.toLowerCase()).toContain('assistant');
    });
  });
});
