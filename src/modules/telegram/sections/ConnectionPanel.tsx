import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

import { Badge } from '../../../shared/ui/Badge';
import { Button } from '../../../shared/ui/Button';
import { IconButton } from '../../../shared/ui/IconButton';
import { CopyIcon } from '../../../shared/ui/icons';
import { Input } from '../../../shared/ui/Input';
import { SettingRow } from '../../../settings/SettingRow';
import { copyText } from '../../../shared/util/clipboard';
import * as api from '../api';
import type { ConnectionStatus, TransportStatus } from '../types';

/// Telegram bot token shape: `<numeric bot id>:<35-char secret>`. Matches
/// what BotFather hands out. We keep the check permissive (secret length
/// and alphabet can drift) but strict enough to catch typos and stray
/// strings pasted by accident.
const BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;
const isValidBotToken = (raw: string): boolean =>
  raw.length > 0 && raw.length <= 100 && BOT_TOKEN_RE.test(raw);

export function ConnectionPanel() {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /// Last transport health report (`telegram:status`); `null` = healthy.
  const [transportError, setTransportError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const [next, transport] = await Promise.all([api.status(), api.transportStatus()]);
      setStatus(next);
      setTransportError(transport?.error ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void refresh();
    const unlisteners = [
      listen<TransportStatus>('telegram:status', (e) => setTransportError(e.payload?.error ?? null)),
      listen('telegram:status_changed', () => void refresh()),
    ];
    return () => {
      unlisteners.forEach((p) => void p.then((off) => off()));
    };
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      // Any connection action restarts (or stops) polling, so the old
      // transport report no longer applies.
      setTransportError(null);
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

      {transportError && (
        <TransportErrorRow
          error={transportError}
          busy={busy}
          onReenterToken={() => run(() => api.clearToken())}
        />
      )}

      {status.kind === 'no_token' && (
        <SettingRow
          title="Bot token"
          description="Paste a bot token from @BotFather to begin."
          control={
            <div className="flex items-center gap-2">
              <Input
                size="sm"
                placeholder="Bot token from @BotFather"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                disabled={busy}
                maxLength={100}
                spellCheck={false}
                autoComplete="off"
                invalid={token.length > 0 && !isValidBotToken(token.trim())}
                className="w-56"
              />
              <Button
                size="sm"
                disabled={busy || !isValidBotToken(token.trim())}
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
                size="sm"
                disabled={busy}
                onClick={() => run(() => api.startPairing())}
                tone="accent"
              >
                Start pairing
              </Button>
              <Button
                size="sm"
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
              size="sm"
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

/// Map the transport's raw error (`telegram:status`) onto actionable copy.
/// The backend strings carry the HTTP code — 401 = bad token, 409 =
/// another poller on the same bot.
function describeTransportError(error: string) {
  if (error.includes('401')) {
    return {
      badge: 'Offline',
      tone: 'danger' as const,
      title: 'Token rejected — re-enter the bot token',
      detail: 'Telegram no longer accepts this bot token (revoked or regenerated in @BotFather).',
      tokenAction: true,
    };
  }
  if (error.includes('409')) {
    return {
      badge: 'Conflict',
      tone: 'warning' as const,
      title: 'Another Stash instance is polling this bot',
      detail: 'Quit the other instance using this token. Stash keeps retrying in the background.',
      tokenAction: false,
    };
  }
  return {
    badge: 'Offline',
    tone: 'danger' as const,
    title: 'Connection problem',
    detail: error,
    tokenAction: false,
  };
}

function TransportErrorRow({
  error,
  busy,
  onReenterToken,
}: {
  error: string;
  busy: boolean;
  onReenterToken: () => void;
}) {
  const d = describeTransportError(error);
  return (
    <div role="alert" className="flex items-start justify-between gap-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Badge tone={d.tone}>{d.badge}</Badge>
          <span className="t-primary text-body font-medium">{d.title}</span>
        </div>
        <div className="t-tertiary text-meta mt-1">{d.detail}</div>
      </div>
      {d.tokenAction && (
        <div className="shrink-0">
          <Button size="sm" tone="danger" variant="soft" disabled={busy} onClick={onReenterToken}>
            Re-enter token
          </Button>
        </div>
      )}
    </div>
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
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(id);
  }, [copied]);
  const onCopy = async () => {
    if (await copyText(`/pair ${code}`)) setCopied(true);
  };

  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="t-primary text-body font-medium">Pairing…</div>
        <div className="t-tertiary text-meta">
          Send <code>/pair {code}</code> to your bot within {mm}:{ss}.
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div
            aria-label="pairing code"
            className="text-3xl font-mono tracking-wider"
          >
            {code}
          </div>
          <IconButton
            title={copied ? 'Copied' : 'Copy /pair command'}
            onClick={onCopy}
            data-testid="copy-pair-code"
          >
            <CopyIcon size={14} />
          </IconButton>
          {copied && (
            <span
              className="text-meta t-tertiary"
              role="status"
              aria-live="polite"
            >
              Copied
            </span>
          )}
        </div>
      </div>
      <div className="shrink-0">
        <Button size="sm" disabled={busy} onClick={onCancel}>
          Cancel pairing
        </Button>
      </div>
    </div>
  );
}
