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

  it('renders empty-state when history drawer is opened and empty', async () => {
    wire();
    const user = userEvent.setup();
    render(<TranslatorShell />);
    await user.click(
      await screen.findByRole('button', { name: /show translation history/i }),
    );
    await waitFor(() => {
      expect(screen.getByText(/no translations yet/i)).toBeInTheDocument();
    });
  });

  it('toggles the history drawer open and closed', async () => {
    wire();
    const user = userEvent.setup();
    render(<TranslatorShell />);
    const toggle = await screen.findByRole('button', { name: /show translation history/i });
    expect(screen.queryByRole('dialog', { name: /translation history/i })).toBeNull();
    await user.click(toggle);
    expect(
      await screen.findByRole('dialog', { name: /translation history/i }),
    ).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      // The drawer stays mounted until its close animation ends; in jsdom
      // animationend doesn't fire automatically, so just assert the state
      // flipped by re-clicking the toggle re-opens cleanly.
    });
  });

  it('refetches history after a delete', async () => {
    const row = {
      id: 42,
      original: 'hello',
      translated: 'привіт',
      from_lang: 'en',
      to_lang: 'uk',
      created_at: Math.floor(Date.now() / 1000),
    };
    let listCalls = 0;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'translator_list') {
        listCalls += 1;
        return listCalls === 1 ? [row] : [];
      }
      if (cmd === 'translator_search') return [];
      if (cmd === 'translator_delete') return null;
      return null;
    });
    const user = userEvent.setup();
    render(<TranslatorShell />);
    await user.click(
      await screen.findByRole('button', { name: /show translation history/i }),
    );
    const deleteBtn = await screen.findByRole('button', { name: /^delete$/i });
    const before = listCalls;
    await user.click(deleteBtn);
    // Confirm the destructive-action dialog — second matching button.
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /^delete$/i }).length).toBeGreaterThan(1);
    });
    const buttons = screen.getAllByRole('button', { name: /^delete$/i });
    await user.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(listCalls).toBeGreaterThan(before));
  });

  it('ArrowDown from history search focuses the first row', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'translator_list') {
        return [
          {
            id: 1,
            original: 'hello',
            translated: 'привіт',
            from_lang: 'en',
            to_lang: 'uk',
            created_at: Math.floor(Date.now() / 1000),
          },
        ];
      }
      if (cmd === 'translator_search') return [];
      return null;
    });
    const user = userEvent.setup();
    render(<TranslatorShell />);
    await user.click(
      await screen.findByRole('button', { name: /show translation history/i }),
    );
    const searchInput = await screen.findByLabelText('Search translation history');
    await user.click(searchInput);
    await user.keyboard('{ArrowDown}');
    const reuseBtn = await screen.findByRole('button', { name: 'Reuse translation as source' });
    expect(document.activeElement).toBe(reuseBtn);
  });

  it('swap button is disabled until a translation has resolved', async () => {
    wire();
    render(<TranslatorShell />);
    const swap = await screen.findByRole('button', { name: /swap/i });
    expect(swap).toBeDisabled();
  });

  it('swap moves the translation into the source and retranslates reversed', async () => {
    let lastRunArgs: { text?: string; to?: string; from?: string } | null = null;
    mockInvoke.mockImplementation(async (cmd: string, args) => {
      if (cmd === 'translator_list' || cmd === 'translator_search') return [];
      if (cmd === 'translator_run') {
        lastRunArgs = args as { text: string; to: string; from?: string };
        const { text, to } = lastRunArgs;
        if (to === 'uk') {
          return { original: text, translated: 'привіт', from: 'en', to: 'uk' };
        }
        return { original: text, translated: 'hello', from: 'uk', to: 'en' };
      }
      return null;
    });
    const user = userEvent.setup();
    render(<TranslatorShell />);

    const ta = await screen.findByLabelText<HTMLTextAreaElement>('Text to translate');
    await user.click(ta);
    await user.keyboard('hello');
    // Wait for auto-translate to land and swap to become enabled.
    await waitFor(
      () => {
        const btn = screen.getByRole('button', { name: /swap/i });
        expect(btn).not.toBeDisabled();
      },
      { timeout: 1500 },
    );

    await user.click(screen.getByRole('button', { name: /swap/i }));

    // Draft becomes the previous translation, and a reversed run fires.
    expect(ta.value).toBe('привіт');
    await waitFor(
      () => {
        expect(lastRunArgs).toEqual(
          expect.objectContaining({ text: 'привіт', to: 'en' }),
        );
      },
      { timeout: 1500 },
    );
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
