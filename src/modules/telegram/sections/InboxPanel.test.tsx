import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';

import { InboxPanel } from './InboxPanel';
import type { InboxItem } from '../types';

const mkItem = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 1,
  telegram_message_id: 101,
  kind: 'text',
  text_content: 'hello world',
  file_path: null,
  mime_type: null,
  duration_sec: null,
  transcript: null,
  caption: null,
  received_at: Math.floor(Date.now() / 1000),
  routed_to: null,
  ...over,
});

describe('<InboxPanel />', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('shows empty-state when list is empty', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_list_inbox') return [];
      return undefined;
    });
    render(<InboxPanel />);
    expect(
      await screen.findByText(/nothing yet/i),
    ).toBeInTheDocument();
  });

  it('renders a text item with preview and action buttons', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_list_inbox')
        return [mkItem({ id: 7, text_content: 'paycheck arrived' })];
      return undefined;
    });
    render(<InboxPanel />);
    expect(await screen.findByText('paycheck arrived')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /→ Notes/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /→ Clipboard/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Delete/ })).toBeEnabled();
  });

  it('routing button calls telegram_mark_inbox_routed', async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_list_inbox')
        return [mkItem({ id: 7, text_content: 'something' })];
      if (cmd === 'telegram_mark_inbox_routed') return undefined;
      return undefined;
    });
    render(<InboxPanel />);
    await screen.findByText('something');
    await user.click(screen.getByRole('button', { name: /→ Notes/ }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('telegram_mark_inbox_routed', {
        id: 7,
        target: 'notes',
      }),
    );
  });

  it('delete button calls telegram_delete_inbox_item', async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_list_inbox') return [mkItem({ id: 9 })];
      if (cmd === 'telegram_delete_inbox_item') return undefined;
      return undefined;
    });
    render(<InboxPanel />);
    await screen.findByText('hello world');
    await user.click(screen.getByRole('button', { name: /Delete/ }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('telegram_delete_inbox_item', {
        id: 9,
      }),
    );
  });

  it('non-text items disable routing buttons', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_list_inbox')
        return [mkItem({ id: 5, kind: 'voice', text_content: null })];
      return undefined;
    });
    render(<InboxPanel />);
    await screen.findByTestId('inbox-item-5');
    expect(screen.getByRole('button', { name: /→ Notes/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /→ Clipboard/ })).toBeDisabled();
    // Delete remains enabled.
    expect(screen.getByRole('button', { name: /Delete/ })).toBeEnabled();
  });

  it('shows routed tag when item was routed before', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_list_inbox')
        return [mkItem({ id: 3, routed_to: 'notes' })];
      return undefined;
    });
    render(<InboxPanel />);
    expect(await screen.findByText(/→ notes/)).toBeInTheDocument();
  });
});
