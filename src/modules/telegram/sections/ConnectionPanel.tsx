import { useEffect, useState } from 'react';

import { Button } from '../../../shared/ui/Button';
import { Input } from '../../../shared/ui/Input';
import { SettingRow } from '../../../settings/SettingRow';
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
    <>
      {error && (
        <div role="alert" className="py-3 t-danger text-meta">
          {error}
        </div>
      )}

      {status.kind === 'no_token' && (
        <SettingRow
          title="Bot token"
          description="Paste a bot token from @BotFather to begin."
          control={
            <div className="flex items-center gap-2">
              <Input
                placeholder="Bot token from @BotFather"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                disabled={busy}
                className="w-56"
              />
              <Button
                disabled={busy || token.trim().length === 0}
                onClick={() => run(() => api.setToken(token.trim()))}
              >
                Save token
              </Button>
            </div>
          }
        />
      )}

      {status.kind === 'token_only' && (
        <SettingRow
          title="Pair a chat"
          description="Token saved. Start pairing to link a Telegram chat."
          control={
            <div className="flex items-center gap-2">
              <Button
                disabled={busy}
                onClick={() => run(() => api.startPairing())}
                tone="accent"
              >
                Start pairing
              </Button>
              <Button
                disabled={busy}
                onClick={() => run(() => api.clearToken())}
              >
                Remove token
              </Button>
            </div>
          }
        />
      )}

      {status.kind === 'pairing' && (
        <PairingRow
          code={status.code}
          expiresAt={status.expires_at}
          busy={busy}
          onCancel={() => run(() => api.cancelPairing())}
        />
      )}

      {status.kind === 'paired' && (
        <SettingRow
          title="Connected"
          description={`Paired with chat ${status.chat_id}.`}
          control={
            <Button
              disabled={busy}
              onClick={() => run(() => api.unpair())}
              tone="danger"
              variant="soft"
            >
              Unpair
            </Button>
          }
        />
      )}
    </>
  );
}

function PairingRow({
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
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="t-primary text-body font-medium">Pairing…</div>
        <div className="t-tertiary text-meta">
          Send <code>/pair {code}</code> to your bot within {mm}:{ss}.
        </div>
        <div
          aria-label="pairing code"
          className="mt-2 text-3xl font-mono tracking-wider"
        >
          {code}
        </div>
      </div>
      <div className="shrink-0">
        <Button disabled={busy} onClick={onCancel}>
          Cancel pairing
        </Button>
      </div>
    </div>
  );
}
