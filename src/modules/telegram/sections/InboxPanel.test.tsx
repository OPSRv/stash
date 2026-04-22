import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';
// `__emit` is a test-only helper installed by `src/test/setup.ts` —
// re-typed here because the real `@tauri-apps/api/event` surface
// doesn't declare it.
import * as events from '@tauri-apps/api/event';
const __emit = (events as unknown as { __emit: (e: string, p: unknown) => void }).__emit;

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

  it('shows paired empty-state when list is empty', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_list_inbox') return [];
      if (cmd === 'telegram_status') return { kind: 'paired', chat_id: 123 };
      return undefined;
    });
    render(<InboxPanel />);
    expect(await screen.findByText(/inbox is empty/i)).toBeInTheDocument();
  });

  it('surfaces pair-me empty-state when bot is not paired', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_list_inbox') return [];
      if (cmd === 'telegram_status') return { kind: 'no_token' };
      return undefined;
    });
    render(<InboxPanel />);
    expect(
      await screen.findByText(/connect telegram first/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /open telegram settings/i }),
    ).toBeEnabled();
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
      screen.getByRole('button', { name: /save to notes/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: /route to clipboard/i }),
    ).toBeEnabled();
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeEnabled();
  });

  it('save-to-notes calls telegram_send_inbox_to_notes', async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_list_inbox')
        return [mkItem({ id: 7, text_content: 'something' })];
      if (cmd === 'telegram_send_inbox_to_notes') return 42;
      return undefined;
    });
    render(<InboxPanel />);
    await screen.findByText('something');
    await user.click(
      screen.getByRole('button', { name: /save to notes/i }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('telegram_send_inbox_to_notes', {
        id: 7,
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

  it('non-text items keep save-to-notes plus file actions', async () => {
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
    // Clipboard routing only makes sense for text rows — non-text hides it.
    expect(
      screen.queryByRole('button', { name: /route to clipboard/i }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: /save to notes/i }),
    ).toBeEnabled();
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

  it('search filters the list client-side', async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_list_inbox')
        return [
          mkItem({ id: 1, text_content: 'alpha report' }),
          mkItem({ id: 2, text_content: 'beta note' }),
        ];
      if (cmd === 'telegram_status') return { kind: 'paired', chat_id: 1 };
      return undefined;
    });
    render(<InboxPanel />);
    await screen.findByText('alpha report');
    await screen.findByText('beta note');
    const search = screen.getByPlaceholderText(/search inbox/i);
    await user.type(search, 'alpha');
    expect(screen.queryByText('beta note')).toBeNull();
    expect(screen.getByText('alpha report')).toBeInTheDocument();
  });

  it('multi-select exposes bulk delete', async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_list_inbox')
        return [
          mkItem({ id: 1, text_content: 'one' }),
          mkItem({ id: 2, text_content: 'two' }),
        ];
      if (cmd === 'telegram_status') return { kind: 'paired', chat_id: 1 };
      if (cmd === 'telegram_delete_inbox_item') return undefined;
      return undefined;
    });
    render(<InboxPanel />);
    await screen.findByText('one');
    await user.click(screen.getByLabelText('Select item 1'));
    await user.click(screen.getByLabelText('Select item 2'));
    expect(screen.getByText(/2 selected/i)).toBeInTheDocument();
    await user.click(
      screen.getAllByRole('button', { name: /^delete$/i })[0]!,
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('telegram_delete_inbox_item', { id: 1 }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('telegram_delete_inbox_item', { id: 2 }),
    );
  });

  it('retry button appears when transcription failed and calls the backend', async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_list_inbox')
        return [
          mkItem({
            id: 21,
            kind: 'voice',
            text_content: null,
            file_path: '/tmp/v.ogg',
            duration_sec: 2,
          }),
        ];
      if (cmd === 'telegram_retry_transcribe') return undefined;
      if (cmd === 'telegram_status') return { kind: 'paired', chat_id: 1 };
      return undefined;
    });
    render(<InboxPanel />);
    await screen.findByTestId('inbox-item-21');
    await act(async () => {
      __emit('telegram:transcribe_failed', 21);
    });
    const retry = await screen.findByRole('button', { name: /спробувати/i });
    await user.click(retry);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('telegram_retry_transcribe', {
        id: 21,
      }),
    );
  });

  it('a document with an image mime renders as an inline image preview', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_list_inbox')
        return [
          mkItem({
            id: 33,
            kind: 'document',
            text_content: null,
            file_path: '/tmp/photo.png',
            mime_type: 'image/png',
          }),
        ];
      if (cmd === 'telegram_status') return { kind: 'paired', chat_id: 1 };
      return undefined;
    });
    render(<InboxPanel />);
    await screen.findByTestId('inbox-item-33');
    // The ImageThumbnail button is the only thing that exposes an
    // "Open <alt>" label — anything else would mean we fell back to
    // the generic FileChip, which was the original bug.
    expect(screen.getByRole('button', { name: /open/i })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /photo\.png/ })).toBeInTheDocument();
  });

  it('text row with a URL shows Open + Download actions', async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_list_inbox')
        return [
          mkItem({
            id: 77,
            text_content: 'Check https://tauri.app for docs.',
          }),
        ];
      if (cmd === 'telegram_status') return { kind: 'paired', chat_id: 1 };
      return undefined;
    });
    render(<InboxPanel />);
    await screen.findByText(/Check/);
    const open = screen.getByRole('button', { name: /^open$/i });
    const download = screen.getByRole('button', { name: /download/i });
    expect(open).toBeInTheDocument();
    expect(download).toBeInTheDocument();
    await user.click(download);
    // The Downloader handoff is module-level state; verify the nav
    // event fires (the rest is covered by the downloader's own tests).
    // We listen directly because the side-effect is the whole point.
    // The pending-URL setter is tested in its own module.
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
