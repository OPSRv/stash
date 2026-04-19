import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { TranslatorShell } from './TranslatorShell';

const mockInvoke = vi.mocked(invoke);

/// Default mock: return an empty list for translator_list / translator_search
/// and a sensible translation result for translator_run. Individual tests can
/// override per-call.
const wire = (
  translateResult?: Partial<{
    original: string;
    translated: string;
    from: string;
    to: string;
  }>,
) => {
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'translator_list' || cmd === 'translator_search') return [];
    if (cmd === 'translator_run') {
      return {
        original: 'привіт',
        translated: 'hello',
        from: 'uk',
        to: 'en',
        ...translateResult,
      };
    }
    return null;
  });
};

describe('TranslatorShell', () => {
  it('renders both panes with from/to language labels', async () => {
    wire();
    render(<TranslatorShell />);
    // Header chips
    await waitFor(() => {
      expect(screen.getByText(/from/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/^to$/i)).toBeInTheDocument();
    // Source textarea visible
    expect(screen.getByLabelText('Text to translate')).toBeInTheDocument();
    // Target pane empty-state
    expect(screen.getByText(/translation appears here/i)).toBeInTheDocument();
  });

  it('shows keyboard shortcut hints', async () => {
    wire();
    render(<TranslatorShell />);
    expect(await screen.findByText('⌘K')).toBeInTheDocument();
    expect(screen.getByText('⌘↵')).toBeInTheDocument();
  });

  it('renders empty-state when history is empty', async () => {
    wire();
    render(<TranslatorShell />);
    await waitFor(() => {
      expect(screen.getByText(/no translations yet/i)).toBeInTheDocument();
    });
  });

  it('Escape clears a non-empty draft', async () => {
    wire();
    const user = userEvent.setup();
    render(<TranslatorShell />);
    const ta = await screen.findByLabelText<HTMLTextAreaElement>('Text to translate');
    await user.click(ta);
    await user.keyboard('hello');
    expect(ta.value).toBe('hello');
    // blur textarea, then Escape
    ta.blur();
    await user.keyboard('{Escape}');
    expect(ta.value).toBe('');
  });
});
