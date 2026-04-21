import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

import { Button } from '../../../shared/ui/Button';
import * as api from '../api';
import type { InboxItem, InboxKind, RouteTarget } from '../types';

const KIND_ICON: Record<InboxKind, string> = {
  text: '💬',
  voice: '🎤',
  photo: '📷',
  document: '📎',
  video: '🎥',
  sticker: '🔖',
};

function formatTime(unixSecs: number) {
  const d = new Date(unixSecs * 1000);
  return d.toLocaleString();
}

function preview(item: InboxItem): string {
  if (item.text_content) {
    return item.text_content.length > 200
      ? `${item.text_content.slice(0, 200)}…`
      : item.text_content;
  }
  if (item.transcript) return `🎤 ${item.transcript}`;
  if (item.caption) return item.caption;
  return `[${item.kind}]`;
}

export function InboxPanel() {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setItems(await api.listInbox());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    let unlisten: (() => void) | undefined;
    Promise.all([
      listen('telegram:inbox_added', refresh),
      listen('telegram:inbox_updated', refresh),
    ]).then(([a, b]) => {
      unlisten = () => {
        a();
        b();
      };
    });
    return () => {
      unlisten?.();
    };
  }, [refresh]);

  const runOn = async (id: number, fn: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  if (!items) return null;

  return (
    <section className="p-4 flex flex-col gap-2">
      <h2 className="text-base font-semibold">Inbox</h2>
      {error && (
        <p role="alert" className="text-sm text-[rgba(239,68,68,0.9)]">
          {error}
        </p>
      )}
      {items.length === 0 ? (
        <p className="text-sm t-secondary">
          Nothing yet. Send the bot a plain-text message and it will land here.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="inbox items">
          {items.map((item) => (
            <li
              key={item.id}
              className="border border-white/10 rounded-md p-2 flex flex-col gap-1"
              data-testid={`inbox-item-${item.id}`}
            >
              <div className="flex items-center gap-2 text-xs t-secondary">
                <span aria-hidden>{KIND_ICON[item.kind] ?? '📥'}</span>
                <span>{formatTime(item.received_at)}</span>
                {item.routed_to && (
                  <span className="ml-auto text-[11px] opacity-80">
                    → {item.routed_to}
                  </span>
                )}
              </div>
              <p className="text-sm whitespace-pre-wrap">{preview(item)}</p>
              <div className="flex gap-1 pt-1">
                <Button
                  size="xs"
                  disabled={busyId === item.id || item.kind !== 'text'}
                  onClick={() =>
                    runOn(item.id, async () => {
                      await api.markInboxRouted(item.id, 'notes');
                    })
                  }
                  title="Mark as routed to Notes"
                >
                  → Notes
                </Button>
                <Button
                  size="xs"
                  disabled={busyId === item.id || item.kind !== 'text'}
                  onClick={() =>
                    runOn(item.id, async () => {
                      await api.markInboxRouted(item.id, 'clipboard');
                    })
                  }
                  title="Mark as routed to Clipboard"
                >
                  → Clipboard
                </Button>
                <Button
                  size="xs"
                  tone="danger"
                  variant="soft"
                  disabled={busyId === item.id}
                  onClick={() =>
                    runOn(item.id, async () => {
                      await api.deleteInboxItem(item.id);
                    })
                  }
                  className="ml-auto"
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type RouteHandler = (id: number, target: RouteTarget) => Promise<void>;
// Exported so a future Phase 2 can inject transcribe/open actions for non-text kinds.
export type { RouteHandler };
