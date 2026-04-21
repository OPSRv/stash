import { useEffect, useState } from 'react';

import { Button } from '../../../shared/ui/Button';
import { Input } from '../../../shared/ui/Input';
import * as api from '../api';
import type { ConnectionStatus } from '../types';

export function ConnectionPanel() {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setStatus(await api.status());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;

  return (
    <section className="p-4 flex flex-col gap-3">
      <h2 className="text-base font-semibold">Telegram</h2>
      {error && (
        <p role="alert" className="text-sm text-[rgba(239,68,68,0.9)]">
          {error}
        </p>
      )}

      {status.kind === 'no_token' && (
        <div className="flex flex-col gap-2">
          <p className="text-sm t-secondary">
            Paste a bot token from @BotFather to begin.
          </p>
          <Input
            placeholder="Bot token from @BotFather"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={busy}
          />
          <Button
            disabled={busy || token.trim().length === 0}
            onClick={() => run(() => api.setToken(token.trim()))}
          >
            Save token
          </Button>
        </div>
      )}

      {status.kind === 'token_only' && (
        <div className="flex flex-col gap-2">
          <p className="text-sm t-secondary">
            Token saved. Start pairing to link a chat.
          </p>
          <div className="flex gap-2">
            <Button
              disabled={busy}
              onClick={() => run(() => api.startPairing())}
              tone="accent"
            >
              Start pairing
            </Button>
            <Button disabled={busy} onClick={() => run(() => api.clearToken())}>
              Remove token
            </Button>
          </div>
        </div>
      )}

      {status.kind === 'pairing' && (
        <PairingView
          code={status.code}
          expiresAt={status.expires_at}
          busy={busy}
          onCancel={() => run(() => api.cancelPairing())}
        />
      )}

      {status.kind === 'paired' && (
        <div className="flex flex-col gap-2">
          <p className="text-sm">Paired with chat {status.chat_id}.</p>
          <div>
            <Button
              disabled={busy}
              onClick={() => run(() => api.unpair())}
              tone="danger"
              variant="soft"
            >
              Unpair
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function PairingView({
  code,
  expiresAt,
  busy,
  onCancel,
}: {
  code: string;
  expiresAt: number;
  busy: boolean;
  onCancel: () => void;
}) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
  );
  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(Math.max(0, expiresAt - Math.floor(Date.now() / 1000)));
    }, 1_000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const mm = Math.floor(remaining / 60);
  const ss = (remaining % 60).toString().padStart(2, '0');

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">
        Send <code>/pair {code}</code> to your bot within {mm}:{ss}.
      </p>
      <p aria-label="pairing code" className="text-3xl font-mono tracking-wider">
        {code}
      </p>
      <div>
        <Button disabled={busy} onClick={onCancel}>
          Cancel pairing
        </Button>
      </div>
    </div>
  );
}
