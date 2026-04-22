import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';

import { ConnectionPanel } from './ConnectionPanel';

describe('<ConnectionPanel />', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('shows the token paste field when not configured', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_status') return { kind: 'no_token' };
      return undefined;
    });
    render(<ConnectionPanel />);
    expect(
      await screen.findByPlaceholderText(/bot token/i),
    ).toBeInTheDocument();
  });

  it('saves a pasted token via telegram_set_token', async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_status') return { kind: 'no_token' };
      if (cmd === 'telegram_set_token') return undefined;
      return undefined;
    });
    render(<ConnectionPanel />);
    const input = await screen.findByPlaceholderText(/bot token/i);
    // Realistic BotFather shape: `<numeric id>:<~35-char secret>`. The
    // client-side shape check rejects anything shorter so typos never
    // reach the backend.
    const token = '123456789:AAE6Kq5mLZs4V8BqZxG-0123456789xYZ';
    await user.type(input, token);
    await user.click(screen.getByRole('button', { name: /save token/i }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('telegram_set_token', { token }),
    );
  });

  it('renders the pairing code when status=pairing', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_status')
        return {
          kind: 'pairing',
          code: '654321',
          expires_at: Math.floor(Date.now() / 1000) + 300,
        };
      return undefined;
    });
    render(<ConnectionPanel />);
    const codeEl = await screen.findByLabelText(/pairing code/i);
    expect(codeEl).toHaveTextContent('654321');
  });

  it('offers a Start Pairing button when token-only and starts on click', async () => {
    const user = userEvent.setup();
    let statusReturn: unknown = { kind: 'token_only' };
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_status') return statusReturn;
      if (cmd === 'telegram_start_pairing') {
        statusReturn = {
          kind: 'pairing',
          code: '777777',
          expires_at: Math.floor(Date.now() / 1000) + 300,
        };
        return statusReturn;
      }
      return undefined;
    });
    render(<ConnectionPanel />);
    const btn = await screen.findByRole('button', { name: /start pairing/i });
    await user.click(btn);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('telegram_start_pairing'),
    );
    const codeEl = await screen.findByLabelText(/pairing code/i);
    expect(codeEl).toHaveTextContent('777777');
  });

  it('shows chat id and Unpair button when paired', async () => {
    const user = userEvent.setup();
    let statusReturn: unknown = { kind: 'paired', chat_id: 42 };
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_status') return statusReturn;
      if (cmd === 'telegram_unpair') {
        statusReturn = { kind: 'token_only' };
        return statusReturn;
      }
      return undefined;
    });
    render(<ConnectionPanel />);
    expect(await screen.findByText(/paired with chat 42/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /unpair/i }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('telegram_unpair'));
  });

  it('surfaces errors from set_token', async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_status') return { kind: 'no_token' };
      if (cmd === 'telegram_set_token') {
        throw 'Telegram rejected the token (HTTP 401)';
      }
      return undefined;
    });
    render(<ConnectionPanel />);
    const input = await screen.findByPlaceholderText(/bot token/i);
    const token = '123456789:AAE6Kq5mLZs4V8BqZxG-0123456789xYZ';
    await user.type(input, token);
    await user.click(screen.getByRole('button', { name: /save token/i }));
    expect(
      await screen.findByText(/Telegram rejected the token/i),
    ).toBeInTheDocument();
  });
});
