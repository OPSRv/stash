import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';
import { __emit } from '@tauri-apps/api/event';

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
    expect(await screen.findByText(/inbox is empty/i)).toBeInTheDocument();
  });

  it('renders a text item with body and per-row actions', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_list_inbox')
        return [mkItem({ id: 7, text_content: 'paycheck arrived' })];
      return undefined;
    });
    render(<InboxPanel />);
    expect(await screen.findByText('paycheck arrived')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /route to notes/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: /route to clipboard/i }),
    ).toBeEnabled();
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeEnabled();
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
    await user.click(
      screen.getByRole('button', { name: /route to notes/i }),
    );
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
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('telegram_delete_inbox_item', {
        id: 9,
      }),
    );
  });

  it('non-text items omit routing buttons (file actions only)', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_list_inbox')
        return [
          mkItem({
            id: 5,
            kind: 'voice',
            text_content: null,
            file_path: '/tmp/voice.ogg',
            duration_sec: 2,
          }),
        ];
      return undefined;
    });
    render(<InboxPanel />);
    await screen.findByTestId('inbox-item-5');
    expect(
      screen.queryByRole('button', { name: /route to notes/i }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: /reveal in finder/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeEnabled();
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

  it('surfaces a "транскрибую" banner when transcribing event fires', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_list_inbox')
        return [
          mkItem({
            id: 11,
            kind: 'voice',
            text_content: null,
            file_path: '/tmp/v.ogg',
            duration_sec: 3,
          }),
        ];
      return undefined;
    });
    render(<InboxPanel />);
    await screen.findByTestId('inbox-item-11');
    // The test harness's listen() mock exposes `__emit` to push events.
    await act(async () => {
      __emit('telegram:transcribing', 11);
    });
    expect(await screen.findByText(/транскрибую/i)).toBeInTheDocument();
  });
});
